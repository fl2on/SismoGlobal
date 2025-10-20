
const EARTH_RADIUS_KM = 6371;

export function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
}

export function calculateDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);

    const a = sinLat * sinLat +
        Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        sinLon * sinLon;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_KM * c;
}
