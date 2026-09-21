/**
 * Physical and astronomical constants.
 *
 * Internal unit convention for the whole app:
 *   - distance: kilometres (km), stored as float64
 *   - time:     Julian Date (TT, close enough to UTC at this accuracy), float64
 *   - velocity: km/s
 *
 * Kilometres — not AU — because the app spans Earth's surface (6378 km) to Voyager 1
 * (~2.5e10 km). Float64 has ~15 significant digits, so a metre at Voyager's distance is
 * still representable. Rendering converts to scene units per frame; see lib/render.
 */

/** Astronomical unit, IAU 2012 definition (exact). */
export const AU_KM = 149_597_870.7;

/** Speed of light in vacuum, km/s (exact). */
export const C_KM_S = 299_792.458;

/** Julian Date of the J2000.0 epoch (2000-01-01 12:00 TT). */
export const J2000 = 2_451_545.0;

/** Days in a Julian century. */
export const DAYS_PER_CENTURY = 36_525.0;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;

/**
 * Standard gravitational parameters, km^3/s^2.
 * Values from JPL DE440 / IAU current best estimates.
 */
export const GM = {
  sun: 1.32712440018e11,
  mercury: 2.2032e4,
  venus: 3.24859e5,
  earth: 3.986004418e5,
  moon: 4.9048695e3,
  mars: 4.282837e4,
  jupiter: 1.26686534e8,
  saturn: 3.7931187e7,
  uranus: 5.793939e6,
  neptune: 6.836529e6,
  pluto: 8.71e2,
} as const;

/** Mean equatorial radii, km. */
export const RADIUS = {
  sun: 695_700,
  mercury: 2_439.7,
  venus: 6_051.8,
  earth: 6_378.137,
  moon: 1_737.4,
  mars: 3_396.2,
  jupiter: 71_492,
  saturn: 60_268,
  uranus: 25_559,
  neptune: 24_764,
  pluto: 1_188.3,
} as const;

/**
 * Obliquity of the ecliptic at J2000.0, radians (IAU 2006: 84381.406").
 * Used to convert between the ecliptic frame the ephemerides work in and the
 * equatorial frame TLEs and RA/Dec use.
 */
export const OBLIQUITY_J2000 = (84_381.406 / 3600) * DEG;

/** Moon mass / (Earth + Moon) mass — offsets the Earth from the Earth-Moon barycentre. */
export const MOON_MASS_FRACTION = 0.012_150_586_2;
