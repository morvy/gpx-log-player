// The numbers the driving is judged by. Limits are applied when the page
// draws, so changing one re-judges every stored drive at once; the calibration
// goes into the measuring, so changing it rebuilds the summaries instead.

export const LIMITS = {
  hardAccel: 2.5,        // m/s²
  hardBrake: 3.0,        // m/s²
  // A habit is a rate, not a single moment: over 252 km of the logs of 2026-09-12 to 15 this car saw one
  // pull over 2.5 m/s² and one stop over 3.0, so one in a hundred kilometres is where it stops being rare.
  hardAccelPer100: 1,
  hardBrakePer100: 1,
  brakeLossGood: 0.10,   // share of the recoverable energy left in the pads
  brakeLossBad: 0.25,
  regenShare: 0.12,      // regen back ÷ energy out
  motorwaySpread: 3,     // km/h of speed spread on a motorway stretch
  shortTripKm: 3,
  // What makes a pack weak. coldPackC is the habits' cold trip and the battery's cold pull both: one
  // meaning, one knob. The battery stores the stretches under its detection floors, so moving any of
  // these three re-reads nothing - the page simply sums the stretches that pass them.
  coldPackC: 10,
  weakPackSoc: 10,
  hardPullKw: 40,
  lowSocPercent: 5,
  // What the gap between two drives has to look like to be a charge. Charges are read at draw time from the
  // stored summaries, so all four of these move with a redraw: the rise that says the car was plugged in, the
  // line between a DC charger and a socket, how far the car may sit from where it stopped before the gap
  // stops being one place, and how long a gap may be before an average kW over it means nothing.
  chargeRise: 5,         // points of charge
  dcKw: 8,
  movedM: 300,
  chargeGapHours: 2,
  // What makes two parkings one place, and how often a place has to be used before it is a habit of the
  // driving rather than a trip. Over the owner's logs every second visit to the same spot lands within
  // 60 m of the first and the nearest distinct spot is 122 m away, so 100 m sits in the gap between them.
  // Both are read at draw time, so a driver who parks around a big car park can widen the radius and
  // watch the places merge with no re-import.
  placeRadiusM: 100,
  placeVisits: 2,
};

export const CALIBRATION = {
  massKg: 1600,          // car and driver
  cdaM2: 0.65,
  rolling: 0.010,
  regenEfficiency: 0.85,
  airDensity: 1.2,       // kg/m³
};

// The Honda e's usable pack, for "km more per charge" - one number, kept here so nothing else hardcodes it.
export const USABLE_KWH = 28.5;

// Only a real number is taken: null, "" and true all pass Number() as 0 or 1, and a stored setting is
// whatever some other version of this page wrote - a regenEfficiency of 0 would divide the physics by nought.
const fill = (defaults, given, least) => {
  const out = { ...defaults };
  for (const k in defaults) if (typeof given?.[k] === "number" && given[k] >= least && given[k] < Infinity) out[k] = given[k];
  return out;
};

/**
 * Stored settings are somebody's edits: a missing or unreadable one falls back
 * to the default. A limit is whatever the driver means by it, and a cold pack
 * can be below zero; a calibration constant divides and scales the physics, so
 * it has to stay above nought.
 */
export const LEAST_LIMIT = -50, LEAST_CALIBRATION = 0.001;
export const withLimits = given => {
  const out = fill(LIMITS, given, LEAST_LIMIT);
  // A share cannot be good and bad at once: a "bad" set under "good" means the driver moved one of them
  // past the other, and the one they did not touch is the one that gives way.
  if (out.brakeLossBad < out.brakeLossGood) out.brakeLossBad = out.brakeLossGood;
  return out;
};
export const withCalibration = given => fill(CALIBRATION, given, LEAST_CALIBRATION);

/**
 * A summary carries this so the page can tell a drive measured with other
 * physics from one it may compare - such a summary is rebuilt, not judged.
 */
export const calibrationKey = given => {
  const c = withCalibration(given);
  return Object.keys(CALIBRATION).sort().map(k => `${k}=${c[k]}`).join(" ");
};
