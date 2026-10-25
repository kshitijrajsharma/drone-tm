.pragma library

.import "drone_specs.js" as Specs

// Calculate adjusted battery life based on ground speed using simplified power model
// P_total = P_hover + k * v^2
// Assumes P_hover is 2/3 of total power at test speed (2:1 hover-to-drag ratio)
function calculateAdjustedBatteryLife(droneType, groundSpeed) {
    var specs = Specs.DRONE_SPECS[droneType];
    if (!specs || !specs.max_battery_life_minutes) return 0;

    var tQuoted = specs.max_battery_life_minutes.quoted_value;
    var vTestKmh = specs.max_battery_life_minutes.tested_value;
    var vTestMps = vTestKmh / 3.6;

    if (vTestMps === 0) return tQuoted;

    var numerator = 3 * (vTestMps * vTestMps);
    var denominator = 2 * (vTestMps * vTestMps) + groundSpeed * groundSpeed;

    if (denominator === 0) return 0;

    return tQuoted * (numerator / denominator);
}

// Calculate flight parameters from overlap percentages and altitude
function calculateParameters(forwardOverlap, sideOverlap, agl, gsd, imageInterval, droneType) {
    if (imageInterval === undefined) imageInterval = 2;
    if (droneType === undefined) droneType = Specs.DroneType.DJI_MINI_4_PRO;

    var params = Specs.DRONE_PARAMS[droneType];
    var VERTICAL_FOV = params.VERTICAL_FOV;
    var HORIZONTAL_FOV = params.HORIZONTAL_FOV;
    var GSD_TO_AGL_CONST = params.GSD_TO_AGL_CONST;

    if (gsd) {
        agl = gsd * GSD_TO_AGL_CONST;
    }

    var forwardPhotoHeight = agl * VERTICAL_FOV;
    var sidePhotoWidth = agl * HORIZONTAL_FOV;
    var forwardOverlapDistance = forwardPhotoHeight * forwardOverlap / 100;
    var sideOverlapDistance = sidePhotoWidth * sideOverlap / 100;
    var forwardSpacing = forwardPhotoHeight - forwardOverlapDistance;
    var sideSpacing = sidePhotoWidth - sideOverlapDistance;
    var groundSpeed = forwardSpacing / imageInterval;

    // Cap ground speed per drone type
    if (groundSpeed > 12 &&
        (droneType === Specs.DroneType.DJI_MINI_5_PRO ||
         droneType === Specs.DroneType.DJI_MINI_4_PRO ||
         droneType === Specs.DroneType.DJI_AIR_3)) {
        groundSpeed = 11.5;
    } else if (droneType === Specs.DroneType.POTENSIC_ATOM_1) {
        groundSpeed = 8.0;
    } else if (groundSpeed > 12) {
        groundSpeed = 11.5;
    }

    var adjustedBattery = calculateAdjustedBatteryLife(droneType, groundSpeed);

    return {
        forward_photo_height: Math.round(forwardPhotoHeight),
        side_photo_width: Math.round(sidePhotoWidth),
        forward_spacing: Math.round(forwardSpacing * 100) / 100,
        side_spacing: Math.round(sideSpacing * 100) / 100,
        ground_speed: Math.round(groundSpeed * 100) / 100,
        altitude_above_ground_level: agl,
        adjusted_max_battery_life: Math.round(adjustedBattery * 100) / 100
    };
}

// Waylines shoot on a timer, so a clamped ground speed shrinks the forward
// gap; side spacing is tightened to match (issue #751).
function effectiveSpacing(parameters, flightMode, imageInterval) {
    var forwardSpacing = parameters.forward_spacing;
    var sideSpacing = parameters.side_spacing;
    if (flightMode !== Specs.FlightMode.WAYLINES) {
        return { forward: forwardSpacing, side: sideSpacing };
    }
    var forwardPhotoHeight = parameters.forward_photo_height;
    var sidePhotoWidth = parameters.side_photo_width;
    var actualForwardSpacing = parameters.ground_speed * imageInterval;
    if (forwardPhotoHeight > 0 && sidePhotoWidth > 0 &&
        actualForwardSpacing < forwardSpacing) {
        var matchedSideSpacing =
            sidePhotoWidth * actualForwardSpacing / forwardPhotoHeight;
        if (matchedSideSpacing < sideSpacing) {
            sideSpacing = matchedSideSpacing;
        }
        forwardSpacing = actualForwardSpacing;
    }
    return { forward: forwardSpacing, side: sideSpacing };
}

// 20% of the battery is kept for the return flight.
function exceedsBattery(droneType, flightTimeMinutes) {
    var specs = Specs.DRONE_SPECS[droneType];
    if (!specs || !specs.max_battery_life_minutes) return false;
    var batteryLife = specs.max_battery_life_minutes.tested_value ||
                      specs.max_battery_life_minutes.quoted_value;
    return flightTimeMinutes > (batteryLife * 0.8);
}
