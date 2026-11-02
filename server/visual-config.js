/** Private runtime settings; no image or credential is included in this object. */
export function visualConfig(env = {}) {
  const integer = (name, fallback, minimum, maximum) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw Error(`Invalid ${name}`);
    return value;
  };
  const width = integer('OBS_FRAME_WIDTH', 640, 320, 1920);
  const height = integer('OBS_FRAME_HEIGHT', 360, 180, 1080);
  const reviewConfidence = env.OBS_REVIEW_CONFIDENCE === undefined || env.OBS_REVIEW_CONFIDENCE === '' ? 0.6 : Number(env.OBS_REVIEW_CONFIDENCE);
  if (!Number.isFinite(reviewConfidence) || reviewConfidence < 0.5 || reviewConfidence > 1) throw Error('Invalid OBS_REVIEW_CONFIDENCE');
  const reviewMode = env.OBS_REVIEW_MODE || 'window';
  if (!['window', 'screened'].includes(reviewMode)) throw Error('Invalid OBS_REVIEW_MODE');
  return { reviewMode, width, height, intervalMs: 200, adaptive: true, reviewConfidence };
}
