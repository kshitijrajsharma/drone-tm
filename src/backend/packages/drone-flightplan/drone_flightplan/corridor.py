"""Mirrored by src/qfield-plugin/generate/corridor.js; keep the two in step."""

import math
from itertools import pairwise

import geojson
import pyproj
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform

from drone_flightplan.calculate_parameters import (
    calculate_parameters,
    effective_spacing,
    exceeds_battery,
)
from drone_flightplan.drone_type import DroneType
from drone_flightplan.enums import FlightMode, GimbalAngle
from drone_flightplan.waypoints import remove_middle_points

TO_MERCATOR = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
TO_WGS84 = pyproj.Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def pass_count(corridor_width: float, photo_width: float, side_spacing: float) -> int:
    """The outer photo footprints, not the outer passes, must reach the corridor edges."""
    if corridor_width <= photo_width:
        return 1
    return math.ceil((corridor_width - photo_width) / side_spacing) + 1


def pass_offsets(count: int, side_spacing: float) -> list[float]:
    """Ground metres; positive is left of travel."""
    return [(index - (count - 1) / 2) * side_spacing for index in range(count)]


def densify(line: list[tuple[float, float]], step: float) -> list[tuple[float, float]]:
    points = [line[0]]
    for (ax, ay), (bx, by) in pairwise(line):
        length = math.hypot(bx - ax, by - ay)
        t = step
        while t < length - step * 1e-6:
            points.append((ax + (bx - ax) * t / length, ay + (by - ay) * t / length))
            t += step
        if length > step * 1e-6:
            points.append((bx, by))
    return points


def offset_samples(
    samples: list[tuple[float, float]], centreline: LineString, offset: float
) -> list[tuple[float, float]]:
    """Drops samples that fold back across a bend tighter than the offset."""
    if offset == 0:
        return list(samples)
    shifted = []
    for index, (x, y) in enumerate(samples):
        before = samples[max(index - 1, 0)]
        after = samples[min(index + 1, len(samples) - 1)]
        tx, ty = after[0] - before[0], after[1] - before[1]
        if tx == 0 and ty == 0:
            # The line doubles back here; use the incoming direction instead
            tx, ty = x - before[0], y - before[1]
        norm = math.hypot(tx, ty)
        point = (x - ty / norm * offset, y + tx / norm * offset)
        if centreline.distance(Point(point)) >= abs(offset) * 0.99:
            shifted.append(point)
    return shifted


def simplify(
    points: list[tuple[float, float]], tolerance: float
) -> list[tuple[float, float]]:
    if len(points) < 3:
        return list(points)
    return list(LineString(points).simplify(tolerance, preserve_topology=False).coords)


def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    """0 = north, clockwise; Mercator preserves angles."""
    return (math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) + 360) % 360


def pass_waypoints(
    flight_pass: list[tuple[float, float]], spacing: float, gimbal_angle: str
) -> list[dict]:
    """One heading per straight piece, so the simplifiers keep every bend."""

    def waypoint(x: float, y: float, heading: float, take_photo: bool) -> dict:
        return {
            "coordinates": Point(x, y),
            "angle": heading,
            "take_photo": take_photo,
            "gimbal_angle": gimbal_angle,
        }

    points = []
    last_piece = len(flight_pass) - 2
    for index, ((ax, ay), (bx, by)) in enumerate(pairwise(flight_pass)):
        length = math.hypot(bx - ax, by - ay)
        heading = bearing((ax, ay), (bx, by))
        ux, uy = (bx - ax) / length, (by - ay) / length
        if index == 0:
            points.append(
                waypoint(ax - ux * spacing, ay - uy * spacing, heading, False)
            )
        t = 0.0
        # The next piece starts at b; the margin stops rounding from repeating it.
        while t < length - spacing * 1e-6:
            points.append(waypoint(ax + ux * t, ay + uy * t, heading, True))
            t += spacing
        if index == last_piece:
            points.append(waypoint(bx, by, heading, True))
            points.append(
                waypoint(bx + ux * spacing, by + uy * spacing, heading, False)
            )
    return points


def mercator_scale(coordinates: list[tuple[float, float]]) -> float:
    """Mercator stretches ground distances by 1 / cos(latitude)."""
    mean_latitude = sum(lat for _, lat in coordinates) / len(coordinates)
    return 1 / math.cos(math.radians(mean_latitude))


def corridor_outline(centreline_wgs84: LineString, corridor_width: float) -> list:
    scale = mercator_scale(list(centreline_wgs84.coords))
    centreline = transform(TO_MERCATOR.transform, centreline_wgs84)
    half = corridor_width / 2 * scale
    samples = densify(list(centreline.coords), half / 5)
    right = simplify(offset_samples(samples, centreline, -half), scale)
    left = simplify(offset_samples(samples, centreline, half), scale)
    ring = [TO_WGS84.transform(x, y) for x, y in right + left[::-1]]
    return [*ring, ring[0]]


def read_centreline(area: dict) -> LineString:
    if "features" in area:
        if len(area["features"]) != 1:
            raise ValueError("A corridor needs exactly one LineString feature")
        area = area["features"][0]
    if "geometry" in area:
        area = area["geometry"]
    line = shape(area)
    if not isinstance(line, LineString):
        raise TypeError(f"A corridor needs a LineString, not a {line.geom_type}")
    if line.length == 0:
        raise ValueError("A corridor line needs length")
    return line


def create_corridor_waypoint(
    centreline_area: dict,
    corridor_width: float,
    agl: float,
    gsd: float | None,
    forward_overlap: float,
    side_overlap: float,
    mode: FlightMode = FlightMode.WAYLINES,
    drone_type: DroneType = DroneType.DJI_MINI_4_PRO,
    gimbal_angle: GimbalAngle = GimbalAngle.OFF_NADIR,
    image_interval: int = 2,
) -> dict:
    """create_waypoint's keys plus `pass_count`; `rotation_angle` is None."""
    parameters = calculate_parameters(
        forward_overlap, side_overlap, agl, gsd, image_interval, drone_type
    )
    forward_spacing, side_spacing = effective_spacing(parameters, mode, image_interval)

    if corridor_width <= 0:
        raise ValueError("The corridor width must be more than 0 m")
    centreline_wgs84 = read_centreline(centreline_area)
    scale = mercator_scale(list(centreline_wgs84.coords))
    centreline = transform(TO_MERCATOR.transform, centreline_wgs84)

    count = pass_count(corridor_width, parameters["side_photo_width"], side_spacing)
    forward_step = forward_spacing * scale
    samples = densify(list(centreline.coords), forward_step / 2)

    path = []
    flown = 0
    for offset in pass_offsets(count, side_spacing):
        flight_pass = simplify(
            offset_samples(samples, centreline, offset * scale), scale
        )
        if len(flight_pass) < 2:
            continue
        if flown % 2 == 1:
            flight_pass.reverse()
        path.extend(pass_waypoints(flight_pass, forward_step, gimbal_angle.value))
        flown += 1
    if flown == 0:
        raise ValueError("No pass fits along this line at this width")

    waypoints = remove_middle_points(path) if mode == FlightMode.WAYLINES else path

    ground_distance = sum(
        a["coordinates"].distance(b["coordinates"]) / scale
        for a, b in pairwise(waypoints)
    )
    flight_time_minutes = 0.0
    if parameters["ground_speed"] > 0:
        flight_time_minutes = ground_distance / parameters["ground_speed"] / 60

    features = [
        geojson.Feature(
            geometry=geojson.Point(
                TO_WGS84.transform(point["coordinates"].x, point["coordinates"].y)
            ),
            properties={
                "index": index,
                "heading": point["angle"],
                "take_photo": point["take_photo"],
                "gimbal_angle": point["gimbal_angle"],
            },
        )
        for index, point in enumerate(waypoints)
    ]

    return {
        "geojson": geojson.dumps(geojson.FeatureCollection(features), indent=2),
        "rotation_angle": None,
        "pass_count": flown,
        "battery_warning": exceeds_battery(drone_type, flight_time_minutes),
        "estimated_flight_time_minutes": round(flight_time_minutes, 2),
    }
