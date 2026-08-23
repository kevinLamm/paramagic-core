export const ARC_MIDPOINT_ROLE = 'arc-midpoint';
export const ARC_MAJOR_SPAN = 'major';
export const ARC_MINOR_SPAN = 'minor';

const TAU = Math.PI * 2;
const HALF_TURN_EPSILON = 1e-6;

export function normalizeArcAngle(angle) {
  return (angle + TAU) % TAU;
}

export function arcSweepFromAngles(startAngle, endAngle, middleAngle = null, { major = null, ccw = null } = {}) {
  const ccwDelta = normalizeArcAngle(endAngle - startAngle);
  const middleCcw = Number.isFinite(middleAngle)
    ? normalizeArcAngle(middleAngle - startAngle) <= ccwDelta
    : null;
  const storedCcw = typeof ccw === 'boolean' ? ccw : null;
  const directedCcw = middleCcw ?? storedCcw;
  let span;
  if (typeof directedCcw === 'boolean') {
    // The drawn middle point establishes direction when geometry is first
    // created or loaded. During solving there is no middle point, so the
    // stored per-arc direction remains authoritative even when the endpoints
    // cross the half-turn boundary. Major/minor is then a derived property.
    span = directedCcw ? ccwDelta : -(TAU - ccwDelta);
  } else {
    const spanClass = typeof major === 'boolean'
      ? (major ? ARC_MAJOR_SPAN : ARC_MINOR_SPAN)
      : ARC_MINOR_SPAN;
    if (Math.abs(ccwDelta - Math.PI) <= HALF_TURN_EPSILON) {
      span = Math.PI;
    } else if (spanClass === ARC_MAJOR_SPAN) {
      span = ccwDelta > Math.PI ? ccwDelta : -(TAU - ccwDelta);
    } else {
      span = ccwDelta < Math.PI ? ccwDelta : -(TAU - ccwDelta);
    }
  }
  return {
    span,
    ccw: span >= 0,
    major: Math.abs(span) > Math.PI,
  };
}

export function arcExtentPoints({
  center,
  radius,
  start,
  arcPoint = null,
  end,
  major = null,
  ccw = null,
} = {}) {
  const validPoint = (point) => Array.isArray(point)
    && point.length >= 2
    && point.slice(0, 2).every(Number.isFinite);
  const resolvedRadius = Math.abs(Number(radius));
  if (!validPoint(center) || !validPoint(start) || !validPoint(end) || !Number.isFinite(resolvedRadius)) return [];

  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const middleAngle = validPoint(arcPoint)
    ? Math.atan2(arcPoint[1] - center[1], arcPoint[0] - center[0])
    : null;
  const sweep = arcSweepFromAngles(startAngle, endAngle, middleAngle, { major, ccw });
  const containsAngle = sweep.span >= 0
    ? (angle) => normalizeArcAngle(angle - startAngle) <= sweep.span + 1e-9
    : (angle) => normalizeArcAngle(startAngle - angle) <= -sweep.span + 1e-9;
  const extrema = [0, Math.PI / 2, Math.PI, Math.PI * 3 / 2]
    .filter(containsAngle)
    .map((angle) => [
      center[0] + resolvedRadius * Math.cos(angle),
      center[1] + resolvedRadius * Math.sin(angle),
    ]);
  return [start, end, ...extrema];
}

export function arcDirectionFromPoints(start, middle, end) {
  if (![start, middle, end].every((point) => (
    Array.isArray(point)
    && point.length >= 2
    && point.every(Number.isFinite)
  ))) return null;
  const orientation = (
    (middle[0] - start[0]) * (end[1] - middle[1])
    - (middle[1] - start[1]) * (end[0] - middle[0])
  );
  return Math.abs(orientation) <= 1e-12 ? null : orientation > 0;
}

export function isArcMidpointReference(reference) {
  return reference?.pointRole === ARC_MIDPOINT_ROLE;
}
