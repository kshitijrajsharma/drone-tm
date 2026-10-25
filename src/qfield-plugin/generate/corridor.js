.pragma library

.import "geometry.js" as Geo
.import "parameters.js" as Params
.import "grid.js" as Grid
.import "drone_specs.js" as Specs

// Port of drone_flightplan/corridor.py; keep the two in step.

// The outer photo footprints, not the outer passes, must reach the corridor edges.
function passCount(corridorWidth, photoWidth, sideSpacing) {
    if (corridorWidth <= photoWidth) return 1;
    return Math.ceil((corridorWidth - photoWidth) / sideSpacing) + 1;
}

// Ground metres; positive is left of travel.
function passOffsets(count, sideSpacing) {
    var offsets = [];
    for (var i = 0; i < count; i++) {
        offsets.push((i - (count - 1) / 2) * sideSpacing);
    }
    return offsets;
}

function densify(line, step) {
    var points = [{ x: line[0].x, y: line[0].y }];
    for (var i = 0; i < line.length - 1; i++) {
        var a = line[i];
        var b = line[i + 1];
        var length = Geo.distance(a.x, a.y, b.x, b.y);
        for (var t = step; t < length - step * 1e-6; t += step) {
            points.push({ x: a.x + (b.x - a.x) * t / length, y: a.y + (b.y - a.y) * t / length });
        }
        if (length > step * 1e-6) points.push({ x: b.x, y: b.y });
    }
    return points;
}

function distanceToLine(x, y, line) {
    var best = Infinity;
    for (var i = 0; i < line.length - 1; i++) {
        var d = Geo.pointToSegmentDistance(x, y, line[i].x, line[i].y, line[i + 1].x, line[i + 1].y);
        if (d < best) best = d;
    }
    return best;
}

// Drops samples that fold back across a bend tighter than the offset.
function offsetSamples(samples, centreline, offset) {
    if (offset === 0) return samples.slice();
    var shifted = [];
    for (var i = 0; i < samples.length; i++) {
        var before = samples[Math.max(i - 1, 0)];
        var after = samples[Math.min(i + 1, samples.length - 1)];
        var tx = after.x - before.x;
        var ty = after.y - before.y;
        if (tx === 0 && ty === 0) {
            // The line doubles back here; use the incoming direction instead
            tx = samples[i].x - before.x;
            ty = samples[i].y - before.y;
        }
        var norm = Math.sqrt(tx * tx + ty * ty);
        var x = samples[i].x - ty / norm * offset;
        var y = samples[i].y + tx / norm * offset;
        if (distanceToLine(x, y, centreline) >= Math.abs(offset) * 0.99) {
            shifted.push({ x: x, y: y });
        }
    }
    return shifted;
}

// Douglas-Peucker, matching Shapely's simplify(preserve_topology=False).
function simplify(line, tolerance) {
    if (line.length < 3) return line.slice();
    var keep = [];
    for (var i = 0; i < line.length; i++) keep.push(false);
    keep[0] = true;
    keep[line.length - 1] = true;
    var stack = [[0, line.length - 1]];
    while (stack.length > 0) {
        var range = stack.pop();
        var first = range[0];
        var last = range[1];
        var farthest = -1;
        var farthestDistance = 0;
        for (var j = first + 1; j < last; j++) {
            var d = Geo.pointToSegmentDistance(
                line[j].x, line[j].y, line[first].x, line[first].y, line[last].x, line[last].y
            );
            if (d > farthestDistance) {
                farthestDistance = d;
                farthest = j;
            }
        }
        if (farthest !== -1 && farthestDistance > tolerance) {
            keep[farthest] = true;
            stack.push([first, farthest]);
            stack.push([farthest, last]);
        }
    }
    var simplified = [];
    for (var k = 0; k < line.length; k++) {
        if (keep[k]) simplified.push(line[k]);
    }
    return simplified;
}

// 0 = north, clockwise; Mercator preserves angles.
function bearing(a, b) {
    var degrees = Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI;
    return (degrees + 360) % 360;
}

function waypoint(x, y, heading, takePhoto, gimbalAngle) {
    return { x: x, y: y, angle: heading, take_photo: takePhoto, gimbal_angle: gimbalAngle };
}

// One heading per straight piece, so the simplifiers keep every bend.
function passWaypoints(pass, spacing, gimbalAngle) {
    var points = [];
    for (var i = 0; i < pass.length - 1; i++) {
        var a = pass[i];
        var b = pass[i + 1];
        var length = Geo.distance(a.x, a.y, b.x, b.y);
        var heading = bearing(a, b);
        if (i === 0) {
            points.push(waypoint(
                a.x - (b.x - a.x) / length * spacing, a.y - (b.y - a.y) / length * spacing,
                heading, false, gimbalAngle
            ));
        }
        // The next piece starts at b; the margin stops rounding from repeating it.
        for (var t = 0; t < length - spacing * 1e-6; t += spacing) {
            points.push(waypoint(
                a.x + (b.x - a.x) * t / length, a.y + (b.y - a.y) * t / length,
                heading, true, gimbalAngle
            ));
        }
        if (i === pass.length - 2) {
            points.push(waypoint(b.x, b.y, heading, true, gimbalAngle));
            points.push(waypoint(
                b.x + (b.x - a.x) / length * spacing, b.y + (b.y - a.y) / length * spacing,
                heading, false, gimbalAngle
            ));
        }
    }
    return points;
}

function projectLine(lineCoords) {
    var line = [];
    for (var i = 0; i < lineCoords.length; i++) {
        var projected = Geo.toMercator(lineCoords[i][0], lineCoords[i][1]);
        line.push({ x: projected.x, y: projected.y });
    }
    return line;
}

// Mercator stretches ground distances by 1 / cos(latitude)
function mercatorScale(lineCoords) {
    var latitudeSum = 0;
    for (var i = 0; i < lineCoords.length; i++) latitudeSum += lineCoords[i][1];
    return 1 / Math.cos(latitudeSum / lineCoords.length * Math.PI / 180);
}

function corridorOutline(lineCoords, corridorWidth) {
    var scale = mercatorScale(lineCoords);
    var centreline = projectLine(lineCoords);
    var half = corridorWidth / 2 * scale;
    var samples = densify(centreline, half / 5);
    var right = simplify(offsetSamples(samples, centreline, -half), scale);
    var left = simplify(offsetSamples(samples, centreline, half), scale);
    var outline = right.concat(left.reverse());
    var ring = [];
    for (var i = 0; i < outline.length; i++) {
        var wgs = Geo.toWgs84(outline[i].x, outline[i].y);
        ring.push([wgs.lon, wgs.lat]);
    }
    ring.push(ring[0]);
    return ring;
}

function generateCorridor(lineCoords, config) {
    var agl = config.agl || 115;
    var gsd = config.gsd || null;
    var forwardOverlap = config.forwardOverlap || 70;
    var sideOverlap = config.sideOverlap || 70;
    var flightMode = config.flightMode || Specs.FlightMode.WAYLINES;
    var droneType = config.droneType || Specs.DroneType.DJI_MINI_4_PRO;
    var gimbalAngle = config.gimbalAngle || Specs.GimbalAngle.OFF_NADIR;
    var imageInterval = config.imageInterval || 2;
    var corridorWidth = config.corridorWidth;

    var parameters = Params.calculateParameters(
        forwardOverlap, sideOverlap, agl, gsd, imageInterval, droneType
    );
    var spacing = Params.effectiveSpacing(parameters, flightMode, imageInterval);

    var scale = mercatorScale(lineCoords);
    var centreline = projectLine(lineCoords);

    var count = passCount(corridorWidth, parameters.side_photo_width, spacing.side);
    var offsets = passOffsets(count, spacing.side);
    var forwardStep = spacing.forward * scale;
    var samples = densify(centreline, forwardStep / 2);

    var path = [];
    var flown = 0;
    for (var p = 0; p < offsets.length; p++) {
        var pass = simplify(offsetSamples(samples, centreline, offsets[p] * scale), scale);
        if (pass.length < 2) continue;
        if (flown % 2 === 1) pass.reverse();
        path = path.concat(passWaypoints(pass, forwardStep, gimbalAngle));
        flown++;
    }
    if (flown === 0) throw new Error("No pass fits along this line at this width");

    var waypoints = (flightMode === Specs.FlightMode.WAYLINES)
        ? Grid.removeMiddlePoints(path)
        : path;

    var groundDistance = 0;
    for (var d = 0; d < waypoints.length - 1; d++) {
        groundDistance += Geo.distance(
            waypoints[d].x, waypoints[d].y, waypoints[d + 1].x, waypoints[d + 1].y
        ) / scale;
    }
    var estimatedFlightTimeMinutes = 0;
    if (parameters.ground_speed > 0) {
        estimatedFlightTimeMinutes = (groundDistance / parameters.ground_speed) / 60;
    }

    var features = [];
    for (var w = 0; w < waypoints.length; w++) {
        var wgs = Geo.toWgs84(waypoints[w].x, waypoints[w].y);
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [wgs.lon, wgs.lat] },
            properties: {
                index: w,
                heading: waypoints[w].angle,
                take_photo: waypoints[w].take_photo,
                gimbal_angle: waypoints[w].gimbal_angle
            }
        });
    }

    return {
        geojson: { type: "FeatureCollection", features: features },
        batteryWarning: Params.exceedsBattery(droneType, estimatedFlightTimeMinutes),
        estimatedFlightTimeMinutes: Math.round(estimatedFlightTimeMinutes * 100) / 100,
        parameters: parameters,
        passCount: flown
    };
}
