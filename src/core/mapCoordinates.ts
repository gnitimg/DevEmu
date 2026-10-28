interface Point {
  lat: number;
  lon: number;
}

// GCJ-02 的椭球偏移公式；仅用于底图投影，不改动注入 Android 的 GPS 值。
// 公式参考：https://github.com/wandergis/coordtransform (MIT)。
export function toGoogleMap(point: Point): Point {
  const { lat, lon } = point;
  if (lon < 72.004 || lon > 137.8347 || lat < 18 || lat > 55.8271)
    return { ...point };
  const x = lon - 105,
    y = lat - 35,
    pi = Math.PI;
  const common =
    ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
  let north =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x)) +
    common;
  north += ((20 * Math.sin(y * pi) + 40 * Math.sin((y * pi) / 3)) * 2) / 3;
  north +=
    ((160 * Math.sin((y * pi) / 12) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
  let east =
    300 +
    x +
    2 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x)) +
    common;
  east += ((20 * Math.sin(x * pi) + 40 * Math.sin((x * pi) / 3)) * 2) / 3;
  east +=
    ((150 * Math.sin((x * pi) / 12) + 300 * Math.sin((x * pi) / 30)) * 2) / 3;
  const angle = (lat * pi) / 180;
  const ellipsoid = 1 - 0.006693421622965943 * Math.sin(angle) ** 2;
  return {
    lat:
      lat +
      (north * 180) /
        (((6378245 * (1 - 0.006693421622965943)) /
          (ellipsoid * Math.sqrt(ellipsoid))) *
          pi),
    lon:
      lon +
      (east * 180) / ((6378245 / Math.sqrt(ellipsoid)) * Math.cos(angle) * pi),
  };
}

export function fromGoogleMap(point: Point): Point {
  let candidate = { ...point };
  for (let i = 0; i < 6; i++) {
    const forward = toGoogleMap(candidate);
    const dLat = forward.lat - point.lat,
      dLon = forward.lon - point.lon;
    candidate = { lat: candidate.lat - dLat, lon: candidate.lon - dLon };
    if (Math.abs(dLat) + Math.abs(dLon) < 1e-10) break;
  }
  return candidate;
}
