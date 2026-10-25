import json
import math

import pytest
from drone_flightplan.corridor import (
    TO_MERCATOR,
    create_corridor_waypoint,
    densify,
    offset_samples,
    pass_count,
)
from drone_flightplan.create_flightplan import build_placemarks
from drone_flightplan.enums import FlightMode
from shapely.geometry import LineString, Point
from shapely.ops import transform

# 600 m east, then 400 m north: one right-angle bend
L_ROAD = {
    "type": "Feature",
    "properties": {},
    "geometry": {
        "type": "LineString",
        "coordinates": [[85.3000, 27.7000], [85.3061, 27.7000], [85.3061, 27.7036]],
    },
}

PLAN = {"agl": None, "gsd": 3.5, "forward_overlap": 75, "side_overlap": 75}


def local_metres(lon: float, lat: float) -> Point:
    """Flat-earth metres from the road start, accurate over a few kilometres."""
    return Point(
        (lon - 85.3) * 111320 * math.cos(math.radians(27.7)), (lat - 27.7) * 110574
    )


ROAD_METRES = LineString(
    [local_metres(*position) for position in L_ROAD["geometry"]["coordinates"]]
)


def photos(result: dict) -> list[dict]:
    features = json.loads(result["geojson"])["features"]
    return [feature for feature in features if feature["properties"]["take_photo"]]


@pytest.mark.parametrize(
    ("width", "expected"),
    [(100, 1), (120, 1), (121, 2), (150, 2), (150.01, 3)],
)
def test_pass_count_covers_width_with_outer_footprints(width, expected):
    assert pass_count(width, photo_width=120, side_spacing=30) == expected


def test_photos_stay_within_half_the_corridor_width():
    result = create_corridor_waypoint(
        L_ROAD, corridor_width=250, mode=FlightMode.WAYPOINTS, **PLAN
    )
    farthest = max(
        ROAD_METRES.distance(local_metres(*feature["geometry"]["coordinates"]))
        for feature in photos(result)
    )

    assert result["pass_count"] > 1
    assert farthest < 125


def test_passes_head_along_the_road_and_alternate_direction():
    result = create_corridor_waypoint(
        L_ROAD, corridor_width=250, mode=FlightMode.WAYPOINTS, **PLAN
    )
    headings = {round(feature["properties"]["heading"]) for feature in photos(result)}

    # East and north on outbound passes, south and west on return passes
    assert {0, 90, 180, 270} <= headings


def test_waylines_keep_the_bend():
    result = create_corridor_waypoint(
        L_ROAD, corridor_width=80, mode=FlightMode.WAYLINES, **PLAN
    )
    features = json.loads(result["geojson"])["features"]
    corner = local_metres(85.3061, 27.7000)
    nearest = min(
        corner.distance(local_metres(*feature["geometry"]["coordinates"]))
        for feature in features
    )

    assert result["pass_count"] == 1
    assert nearest < 15


def test_build_placemarks_flies_a_corridor_for_a_line():
    placemarks, waypoint_data = build_placemarks(
        aoi=L_ROAD, corridor_width=250, flight_mode=FlightMode.WAYLINES, **PLAN
    )

    assert waypoint_data["pass_count"] > 1
    assert all("altitude" in f["properties"] for f in placemarks["features"])


def test_corridor_rejects_a_polygon():
    polygon = {
        "type": "Polygon",
        "coordinates": [[[85.3, 27.7], [85.31, 27.7], [85.31, 27.71], [85.3, 27.7]]],
    }

    with pytest.raises(TypeError, match="LineString"):
        create_corridor_waypoint(polygon, corridor_width=100, **PLAN)


# Out 500 m east, a 20 m radius turn, and back west 40 m to the north
HAIRPIN = {
    "type": "LineString",
    "coordinates": [
        [85.3, 27.7],
        [85.305, 27.7],
        [85.3052, 27.70018],
        [85.305, 27.70036],
        [85.3, 27.70036],
    ],
}


def test_hairpin_inner_pass_drops_samples_that_fold_back_over_the_road():
    road = transform(TO_MERCATOR.transform, LineString(HAIRPIN["coordinates"]))
    samples = densify(list(road.coords), 5)
    # The legs are about 45 Mercator units apart; positive offsets are to the left
    inside = offset_samples(samples, road, 30)
    outside = offset_samples(samples, road, -30)

    assert len(inside) < len(samples)
    assert len(outside) == len(samples)
    assert min(road.distance(Point(point)) for point in outside) >= 30 * 0.99


def test_build_placemarks_rejects_grid_only_arguments_for_a_corridor():
    with pytest.raises(ValueError, match="rotation_angle"):
        build_placemarks(aoi=L_ROAD, corridor_width=100, rotation_angle=30, **PLAN)


def test_corridor_rejects_more_than_one_line():
    two_roads = {"type": "FeatureCollection", "features": [L_ROAD, L_ROAD]}

    with pytest.raises(ValueError, match="exactly one"):
        create_corridor_waypoint(two_roads, corridor_width=100, **PLAN)


@pytest.mark.parametrize(
    ("area", "width", "message"),
    [
        (L_ROAD, 0, "more than 0"),
        (
            {"type": "LineString", "coordinates": [[85.3, 27.7], [85.3, 27.7]]},
            100,
            "length",
        ),
    ],
)
def test_corridor_rejects_a_zero_width_or_zero_length_line(area, width, message):
    with pytest.raises(ValueError, match=message):
        create_corridor_waypoint(area, corridor_width=width, **PLAN)
