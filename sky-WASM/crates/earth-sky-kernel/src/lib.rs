//! Atmosphere ray/fan/hemisphere integration, ported from sky/src/atmosphere.ts.
//! Allocation-free and `no_std`: the single registry core (earth-sky) and the
//! shared-memory core (earth-sky-shared) both compile this one copy. Callers
//! own the tables and the per-fan path scratch. Arithmetic remains f64 in the
//! reference expression order; tables retain their f32 rounding. All
//! transcendental functions import the executing WASM instance's JS Math.
#![no_std]

use core::f64::consts::PI;

#[cfg(target_arch = "wasm32")]
mod math {
    #[link(wasm_import_module = "sky_math")]
    unsafe extern "C" {
        #[link_name = "exp"]
        fn imported_exp(x: f64) -> f64;
        #[link_name = "log"]
        fn imported_log(x: f64) -> f64;
        #[link_name = "sqrt"]
        fn imported_sqrt(x: f64) -> f64;
        #[link_name = "sin"]
        fn imported_sin(x: f64) -> f64;
        #[link_name = "cos"]
        fn imported_cos(x: f64) -> f64;
        #[link_name = "pow"]
        fn imported_pow(x: f64, y: f64) -> f64;
    }
    pub fn exp(x: f64) -> f64 {
        unsafe { imported_exp(x) }
    }
    pub fn log(x: f64) -> f64 {
        unsafe { imported_log(x) }
    }
    pub fn sqrt(x: f64) -> f64 {
        unsafe { imported_sqrt(x) }
    }
    pub fn sin(x: f64) -> f64 {
        unsafe { imported_sin(x) }
    }
    pub fn cos(x: f64) -> f64 {
        unsafe { imported_cos(x) }
    }
    pub fn pow(x: f64, y: f64) -> f64 {
        unsafe { imported_pow(x, y) }
    }
}
// A host build may inspect the ABI but must not silently substitute Rust libm
// for the JS functions whose exact results the atmosphere reference uses.
#[cfg(not(target_arch = "wasm32"))]
mod math {
    pub fn exp(_: f64) -> f64 {
        panic!("earth-sky-kernel requires executing-realm JS Math")
    }
    pub fn log(_: f64) -> f64 {
        panic!("earth-sky-kernel requires executing-realm JS Math")
    }
    pub fn sqrt(_: f64) -> f64 {
        panic!("earth-sky-kernel requires executing-realm JS Math")
    }
    pub fn sin(_: f64) -> f64 {
        panic!("earth-sky-kernel requires executing-realm JS Math")
    }
    pub fn cos(_: f64) -> f64 {
        panic!("earth-sky-kernel requires executing-realm JS Math")
    }
    pub fn pow(_: f64, _: f64) -> f64 {
        panic!("earth-sky-kernel requires executing-realm JS Math")
    }
}

pub const RG: f64 = 6_371_000.0;
const RT: f64 = RG + 100_000.0;
const RAYLEIGH: [f64; 3] = [5.802e-6, 13.558e-6, 33.1e-6];
const OZONE: [f64; 3] = [0.65e-6, 1.881e-6, 0.085e-6];
pub const TW: usize = 128;
pub const TH: usize = 64;
pub const MS_SUNS: usize = 33;
pub const MS_HEIGHTS: usize = 24;
pub const GROUND_SUNS: usize = 48;
pub const TRANS_LEN: usize = TW * TH * 3;
pub const MS_LEN: usize = MS_SUNS * MS_HEIGHTS * 3;
pub const GROUND_LEN: usize = GROUND_SUNS * 3;
pub const SNAPSHOT_LEN: usize = 2 + TRANS_LEN + MS_LEN + GROUND_LEN;
pub const MAX_STEPS: usize = 4096;
pub const MAX_DIRECTIONS: usize = 4096;
pub const MAX_STEP_DIRECTIONS: usize = 1_048_576;

pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return f64::from_bits(a.to_bits() | b.to_bits());
    }
    if a < b { a } else { b }
}
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return f64::from_bits(a.to_bits() & b.to_bits());
    }
    if a > b { a } else { b }
}
pub fn cosine(x: f64) -> f64 {
    min(1.0, max(-1.0, x))
}
fn log_mean(a: f64, b: f64, length: f64) -> f64 {
    if a <= 0.0 || b <= 0.0 {
        return 0.5 * (a + b) * length;
    }
    let ratio = math::log(b / a);
    if ratio.abs() < 1e-5 {
        0.5 * (a + b) * length
    } else {
        ((b - a) / ratio) * length
    }
}
fn ozone_density(h: f64) -> f64 {
    max(0.0, 1.0 - (h - 25_000.0).abs() / 15_000.0)
}
fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = min(1.0, max(0.0, (x - a) / (b - a)));
    t * t * (3.0 - 2.0 * t)
}
fn rayleigh_phase(nu: f64) -> f64 {
    (3.0 / (16.0 * PI)) * (1.0 + nu * nu)
}
fn mie_phase(nu: f64) -> f64 {
    let g = 0.8;
    let g2 = g * g;
    (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + nu * nu))
        / ((2.0 + g2) * math::pow(1.0 + g2 - 2.0 * g * nu, 1.5))
}
fn axis_position(mu: f64, least: f64, twilight: usize, day: usize) -> f64 {
    if mu <= 0.15 {
        max(0.0, (mu - least) / (0.15 - least)) * (twilight - 1) as f64
    } else {
        (twilight - 1) as f64 + min(1.0, (mu - 0.15) / (1.0 - 0.15)) * day as f64
    }
}

pub fn valid_inputs(values: &[f64]) -> bool {
    values
        .iter()
        .all(|value| value.is_finite() && value.abs() <= 1e12)
}
pub fn axis_cosine(index: usize, least: f64, twilight: usize, day: usize) -> f64 {
    if index < twilight {
        least + (index as f64 / (twilight - 1) as f64) * (0.15 - least)
    } else {
        0.15 + ((index - twilight + 1) as f64 / day as f64) * (1.0 - 0.15)
    }
}

/// Scalars of one parameter pair. Callers validate the parameters first.
#[derive(Clone, Copy)]
pub struct Parameters {
    pub aerosol: f64,
    pub albedo: f64,
    mie_extinction: f64,
    mie_scattering: f64,
    horizon_to_top: f64,
}
impl Parameters {
    pub fn new(aerosol: f64, albedo: f64) -> Self {
        let extinction = aerosol / 1200.0;
        Self {
            aerosol,
            albedo,
            mie_extinction: extinction,
            mie_scattering: extinction * 0.9,
            horizon_to_top: math::sqrt(RT * RT - RG * RG),
        }
    }
    pub fn extinction_finite(&self) -> bool {
        self.mie_extinction.is_finite()
    }
}

/// A read-only view of complete tables.
pub struct Model<'a> {
    p: Parameters,
    transmittance: &'a [f32],
    multiple: &'a [f32],
    ground: &'a [f32],
    multiple_ready: bool,
    ground_ready: bool,
}

#[derive(Clone, Copy)]
pub struct PathStep {
    middle: f64,
    radius: f64,
    mie: f64,
    rayleigh: [f64; 3],
    scattered: [f64; 3],
    reaching: [f64; 3],
}
impl PathStep {
    pub const ZERO: Self = Self {
        middle: 0.0,
        radius: 0.0,
        mie: 0.0,
        rayleigh: [0.0; 3],
        scattered: [0.0; 3],
        reaching: [0.0; 3],
    };
}

/// Builds the three tables in place, in the reference order. False when a
/// table has the wrong length; nothing is written then.
pub fn build_tables(
    p: &Parameters,
    transmittance: &mut [f32],
    multiple: &mut [f32],
    ground: &mut [f32],
) -> bool {
    if transmittance.len() != TRANS_LEN || multiple.len() != MS_LEN || ground.len() != GROUND_LEN {
        return false;
    }
    let extinction = p.mie_extinction;
    for v in 0..TH {
        let rho = p.horizon_to_top * (v as f64 / (TH - 1) as f64);
        let r = math::sqrt(rho * rho + RG * RG);
        let d_min = RT - r;
        let d_max = rho + p.horizon_to_top;
        for u in 0..TW {
            let d = d_min + (u as f64 / (TW - 1) as f64) * (d_max - d_min);
            let mu = if d <= 0.0 {
                1.0
            } else {
                cosine((p.horizon_to_top * p.horizon_to_top - rho * rho - d * d) / (2.0 * r * d))
            };
            let mut path_rayleigh = 0.0;
            let mut path_mie = 0.0;
            let mut path_ozone = 0.0;
            let climbing = mu >= 0.0;
            let mut h = r - RG;
            let mut density_rayleigh = math::exp(-h * (1.0 / 8000.0));
            let mut density_mie = math::exp(-h * (1.0 / 1200.0));
            let mut density_ozone = ozone_density(h);
            let mut from = 0.0;
            for i in 1..=64 {
                let fraction = i as f64 / 64.0;
                let s = d * if climbing {
                    fraction * fraction
                } else {
                    fraction
                };
                let step = s - from;
                from = s;
                h = max(0.0, math::sqrt(r * r + s * s + 2.0 * r * mu * s) - RG);
                let next_rayleigh = math::exp(-h * (1.0 / 8000.0));
                let next_mie = math::exp(-h * (1.0 / 1200.0));
                let next_ozone = ozone_density(h);
                path_rayleigh += log_mean(density_rayleigh, next_rayleigh, step);
                path_mie += log_mean(density_mie, next_mie, step);
                path_ozone += 0.5 * (density_ozone + next_ozone) * step;
                density_rayleigh = next_rayleigh;
                density_mie = next_mie;
                density_ozone = next_ozone;
            }
            let index = (v * TW + u) * 3;
            for c in 0..3 {
                transmittance[index + c] = (RAYLEIGH[c] * path_rayleigh
                    + extinction * path_mie
                    + OZONE[c] * path_ozone) as f32;
            }
        }
    }
    // Multiple scattering is not consulted while it is built, nor the ground
    // light: the view has neither, as the reference has neither ready.
    {
        let view = Model {
            p: *p,
            transmittance,
            multiple: &[],
            ground: &[],
            multiple_ready: false,
            ground_ready: false,
        };
        for v in 0..MS_HEIGHTS {
            let r = RG + (RT - RG) * (v as f64 / (MS_HEIGHTS - 1) as f64);
            for u in 0..MS_SUNS {
                let mu_sun = axis_cosine(u, -0.45, 25, 8);
                let mut second = [0.0; 3];
                let mut transferred = [0.0; 3];
                let sin_sun = math::sqrt(max(0.0, 1.0 - mu_sun * mu_sun));
                for i in 0..8 {
                    let mu = ((i as f64 + 0.5) / 8.0) * 2.0 - 1.0;
                    let sin_view = math::sqrt(1.0 - mu * mu);
                    for j in 0..4 {
                        let phi = ((j as f64 + 0.5) / 4.0) * PI;
                        let gathered = view.march(
                            r,
                            mu,
                            mu_sun,
                            mu * mu_sun + sin_view * sin_sun * math::cos(phi),
                            12,
                            true,
                            Some(&mut transferred),
                        );
                        second[0] += gathered[0];
                        second[1] += gathered[1];
                        second[2] += gathered[2];
                    }
                }
                let index = (v * MS_SUNS + u) * 3;
                for c in 0..3 {
                    let again = min(0.999, transferred[c] / 32.0);
                    multiple[index + c] =
                        math::log(max(1e-30, (second[c] / 32.0) / (1.0 - again))) as f32;
                }
            }
        }
    }
    let view = Model {
        p: *p,
        transmittance,
        multiple,
        ground: &[],
        multiple_ready: true,
        ground_ready: false,
    };
    for i in 0..GROUND_SUNS {
        let sky = view.irradiance(0.0, axis_cosine(i, -0.35, 36, 12));
        for c in 0..3 {
            ground[i * 3 + c] = math::log(max(1e-30, sky[c])) as f32;
        }
    }
    true
}

impl<'a> Model<'a> {
    pub fn new(
        p: Parameters,
        transmittance: &'a [f32],
        multiple: &'a [f32],
        ground: &'a [f32],
    ) -> Option<Self> {
        if transmittance.len() != TRANS_LEN
            || multiple.len() != MS_LEN
            || ground.len() != GROUND_LEN
        {
            return None;
        }
        Some(Self {
            p,
            transmittance,
            multiple,
            ground,
            multiple_ready: true,
            ground_ready: true,
        })
    }
    /// `Atmosphere.radiance`'s clamping, then one march.
    pub fn radiance(&self, altitude: f64, mu: f64, mu_sun: f64, nu: f64, steps: usize) -> [f64; 3] {
        self.march(
            RG + max(0.0, altitude),
            cosine(mu),
            cosine(mu_sun),
            cosine(nu),
            steps,
            false,
            None,
        )
    }
    fn transmittance_to_top(&self, r: f64, mu: f64) -> [f64; 3] {
        let rho = math::sqrt(max(0.0, r * r - RG * RG));
        let d = max(
            0.0,
            -r * mu + math::sqrt(max(0.0, r * r * (mu * mu - 1.0) + RT * RT)),
        );
        let d_min = RT - r;
        let d_max = rho + self.p.horizon_to_top;
        let x = if d_max > d_min {
            min(1.0, max(0.0, (d - d_min) / (d_max - d_min))) * (TW - 1) as f64
        } else {
            0.0
        };
        let y = min(1.0, rho / self.p.horizon_to_top) * (TH - 1) as f64;
        let x0 = (x as usize).min(TW - 2);
        let y0 = (y as usize).min(TH - 2);
        let fx = x - x0 as f64;
        let fy = y - y0 as f64;
        let a = (y0 * TW + x0) * 3;
        let b = a + TW * 3;
        let mut out = [0.0; 3];
        for (c, value) in out.iter_mut().enumerate() {
            let top = self.transmittance[a + c] as f64
                + (self.transmittance[a + 3 + c] as f64 - self.transmittance[a + c] as f64) * fx;
            let bottom = self.transmittance[b + c] as f64
                + (self.transmittance[b + 3 + c] as f64 - self.transmittance[b + c] as f64) * fx;
            *value = math::exp(-(top + (bottom - top) * fy));
        }
        out
    }
    fn sun_transmittance(&self, r: f64, mu_sun: f64) -> [f64; 3] {
        let sin_horizon = min(1.0, RG / r);
        let cos_horizon = -math::sqrt(max(0.0, 1.0 - sin_horizon * sin_horizon));
        let width = sin_horizon * 0.0046542;
        let visible = smoothstep(-width, width, mu_sun - cos_horizon);
        if visible <= 0.0 {
            return [0.0; 3];
        }
        let mut out = self.transmittance_to_top(r, mu_sun);
        for value in &mut out {
            *value *= visible;
        }
        out
    }
    fn multiple_at(&self, r: f64, mu_sun: f64) -> [f64; 3] {
        if !self.multiple_ready || mu_sun <= -0.45 {
            return [0.0; 3];
        }
        let x = axis_position(mu_sun, -0.45, 25, 8);
        let y = min(1.0, max(0.0, (r - RG) / (RT - RG))) * (MS_HEIGHTS - 1) as f64;
        let x0 = (x as usize).min(MS_SUNS - 2);
        let y0 = (y as usize).min(MS_HEIGHTS - 2);
        let fx = x - x0 as f64;
        let fy = y - y0 as f64;
        let a = (y0 * MS_SUNS + x0) * 3;
        let b = a + MS_SUNS * 3;
        let mut out = [0.0; 3];
        for (c, value) in out.iter_mut().enumerate() {
            let top = self.multiple[a + c] as f64
                + (self.multiple[a + 3 + c] as f64 - self.multiple[a + c] as f64) * fx;
            let bottom = self.multiple[b + c] as f64
                + (self.multiple[b + 3 + c] as f64 - self.multiple[b + c] as f64) * fx;
            *value = math::exp(top + (bottom - top) * fy);
        }
        out
    }
    fn ground_at(&self, mu_sun: f64) -> [f64; 3] {
        if !self.ground_ready {
            return [0.0; 3];
        }
        let x = axis_position(mu_sun, -0.35, 36, 12);
        let x0 = (x as usize).min(GROUND_SUNS - 2);
        let fraction = x - x0 as f64;
        let mut out = [0.0; 3];
        for (c, value) in out.iter_mut().enumerate() {
            *value = math::exp(
                self.ground[x0 * 3 + c] as f64
                    + (self.ground[x0 * 3 + 3 + c] as f64 - self.ground[x0 * 3 + c] as f64)
                        * fraction,
            );
        }
        out
    }
    // The arguments mirror the TypeScript march one to one.
    #[allow(clippy::too_many_arguments)]
    pub fn march(
        &self,
        r0: f64,
        mu0: f64,
        mu_sun0: f64,
        nu: f64,
        steps: usize,
        isotropic: bool,
        mut transfer: Option<&mut [f64; 3]>,
    ) -> [f64; 3] {
        let mut out = [0.0; 3];
        let mut r = r0;
        let mut mu = mu0;
        let mut mu_sun = mu_sun0;
        if r > RT {
            let discriminant = r * r * (mu * mu - 1.0) + RT * RT;
            if mu >= 0.0 || discriminant < 0.0 {
                return out;
            }
            let enter = -r * mu - math::sqrt(discriminant);
            let mu_sun_at_entry = (r * mu_sun + enter * nu) / RT;
            mu = (r * mu + enter) / RT;
            mu_sun = mu_sun_at_entry;
            r = RT;
        }
        r = max(r, RG);
        let ground_discriminant = r * r * (mu * mu - 1.0) + RG * RG;
        let hits_ground = mu < 0.0 && ground_discriminant >= 0.0;
        let length = if hits_ground {
            max(0.0, -r * mu - math::sqrt(ground_discriminant))
        } else {
            max(
                0.0,
                -r * mu + math::sqrt(max(0.0, r * r * (mu * mu - 1.0) + RT * RT)),
            )
        };
        let phase_rayleigh = if isotropic {
            1.0 / (4.0 * PI)
        } else {
            rayleigh_phase(nu)
        };
        let phase_mie = if isotropic {
            1.0 / (4.0 * PI)
        } else {
            mie_phase(nu)
        };
        let mut tau = [0.0; 3];
        let climbing = mu >= 0.0;
        let mut h = r - RG;
        let mut density_rayleigh = math::exp(-h * (1.0 / 8000.0));
        let mut density_mie = math::exp(-h * (1.0 / 1200.0));
        let mut density_ozone = ozone_density(h);
        let mut from = 0.0;
        for i in 1..=steps {
            if length <= 0.0 {
                break;
            }
            let fraction = i as f64 / steps as f64;
            let s = length
                * if climbing {
                    fraction * fraction
                } else {
                    fraction
                };
            let step = s - from;
            let radius = max(RG, math::sqrt(r * r + s * s + 2.0 * r * mu * s));
            h = radius - RG;
            let next_rayleigh = math::exp(-h * (1.0 / 8000.0));
            let next_mie = math::exp(-h * (1.0 / 1200.0));
            let next_ozone = ozone_density(h);
            let path_rayleigh = log_mean(density_rayleigh, next_rayleigh, step);
            let path_mie = log_mean(density_mie, next_mie, step);
            let path_ozone = 0.5 * (density_ozone + next_ozone) * step;
            let before = RAYLEIGH[1] * density_rayleigh + self.p.mie_scattering * density_mie;
            let after = RAYLEIGH[1] * next_rayleigh + self.p.mie_scattering * next_mie;
            let slope = if before > 0.0 && after > 0.0 {
                math::log(before / after)
            } else {
                0.0
            };
            let centre = if slope.abs() < 1e-3 {
                0.5
            } else {
                1.0 / slope - 1.0 / (math::exp(slope) - 1.0)
            };
            density_rayleigh = next_rayleigh;
            density_mie = next_mie;
            density_ozone = next_ozone;
            let middle = from + centre * step;
            from = s;
            let middle_radius = max(
                RG,
                math::sqrt(r * r + middle * middle + 2.0 * r * mu * middle),
            );
            let middle_mu_sun = cosine((r * mu_sun + middle * nu) / middle_radius);
            let sun = self.sun_transmittance(middle_radius, middle_mu_sun);
            let psi = self.multiple_at(middle_radius, middle_mu_sun);
            let scattered_mie = self.p.mie_scattering * path_mie;
            for c in 0..3 {
                let scattered_rayleigh = RAYLEIGH[c] * path_rayleigh;
                let depth =
                    scattered_rayleigh + self.p.mie_extinction * path_mie + OZONE[c] * path_ozone;
                let reaching = math::exp(-tau[c])
                    * if depth > 1e-9 {
                        (1.0 - math::exp(-depth)) / depth
                    } else {
                        1.0
                    };
                let scattered = scattered_rayleigh + scattered_mie;
                out[c] += ((scattered_rayleigh * phase_rayleigh + scattered_mie * phase_mie)
                    * sun[c]
                    + scattered * psi[c])
                    * reaching;
                if let Some(ref mut values) = transfer {
                    values[c] += scattered * reaching;
                }
                tau[c] += depth;
            }
        }
        if hits_ground {
            let ground_mu_sun = cosine((r * mu_sun + length * nu) / RG);
            let sun = self.sun_transmittance(RG, ground_mu_sun);
            let ground = self.ground_at(ground_mu_sun);
            let direct = max(0.0, ground_mu_sun);
            for c in 0..3 {
                out[c] += math::exp(-tau[c])
                    * (self.p.albedo / PI)
                    * (sun[c] * direct + if isotropic { 0.0 } else { ground[c] });
            }
        }
        out
    }
    /// `path` holds at least `steps` entries; it is scratch, not state.
    #[allow(clippy::too_many_arguments)]
    pub fn fan(
        &self,
        altitude: f64,
        mu0: f64,
        mu_sun0: f64,
        nus: &[f64],
        steps: usize,
        path: &mut [PathStep],
        out: &mut [f64],
    ) {
        let r0 = RG + max(0.0, altitude);
        let mu_line = cosine(mu0);
        let mu_sun_line = cosine(mu_sun0);
        out.fill(0.0);
        let mut r = r0;
        let mut mu = mu_line;
        let mut enter = 0.0;
        let mut entered = false;
        if r > RT {
            let discriminant = r * r * (mu * mu - 1.0) + RT * RT;
            if mu >= 0.0 || discriminant < 0.0 {
                return;
            }
            enter = -r * mu - math::sqrt(discriminant);
            entered = true;
            mu = (r * mu + enter) / RT;
            r = RT;
        }
        r = max(r, RG);
        let ground_discriminant = r * r * (mu * mu - 1.0) + RG * RG;
        let hits_ground = mu < 0.0 && ground_discriminant >= 0.0;
        let length = if hits_ground {
            max(0.0, -r * mu - math::sqrt(ground_discriminant))
        } else {
            max(
                0.0,
                -r * mu + math::sqrt(max(0.0, r * r * (mu * mu - 1.0) + RT * RT)),
            )
        };
        let mut tau = [0.0; 3];
        let climbing = mu >= 0.0;
        let mut h = r - RG;
        let mut density_rayleigh = math::exp(-h * (1.0 / 8000.0));
        let mut density_mie = math::exp(-h * (1.0 / 1200.0));
        let mut density_ozone = ozone_density(h);
        let mut from = 0.0;
        let mut taken = 0;
        for i in 1..=steps {
            if length <= 0.0 {
                break;
            }
            let fraction = i as f64 / steps as f64;
            let s = length
                * if climbing {
                    fraction * fraction
                } else {
                    fraction
                };
            let step = s - from;
            let radius = max(RG, math::sqrt(r * r + s * s + 2.0 * r * mu * s));
            h = radius - RG;
            let next_rayleigh = math::exp(-h * (1.0 / 8000.0));
            let next_mie = math::exp(-h * (1.0 / 1200.0));
            let next_ozone = ozone_density(h);
            let path_rayleigh = log_mean(density_rayleigh, next_rayleigh, step);
            let path_mie = log_mean(density_mie, next_mie, step);
            let path_ozone = 0.5 * (density_ozone + next_ozone) * step;
            let before = RAYLEIGH[1] * density_rayleigh + self.p.mie_scattering * density_mie;
            let after = RAYLEIGH[1] * next_rayleigh + self.p.mie_scattering * next_mie;
            let slope = if before > 0.0 && after > 0.0 {
                math::log(before / after)
            } else {
                0.0
            };
            let centre = if slope.abs() < 1e-3 {
                0.5
            } else {
                1.0 / slope - 1.0 / (math::exp(slope) - 1.0)
            };
            density_rayleigh = next_rayleigh;
            density_mie = next_mie;
            density_ozone = next_ozone;
            let middle = from + centre * step;
            from = s;
            let mut point = PathStep {
                middle,
                radius: max(
                    RG,
                    math::sqrt(r * r + middle * middle + 2.0 * r * mu * middle),
                ),
                mie: self.p.mie_scattering * path_mie,
                rayleigh: [0.0; 3],
                scattered: [0.0; 3],
                reaching: [0.0; 3],
            };
            for c in 0..3 {
                let scattered_rayleigh = RAYLEIGH[c] * path_rayleigh;
                let depth =
                    scattered_rayleigh + self.p.mie_extinction * path_mie + OZONE[c] * path_ozone;
                point.reaching[c] = math::exp(-tau[c])
                    * if depth > 1e-9 {
                        (1.0 - math::exp(-depth)) / depth
                    } else {
                        1.0
                    };
                point.rayleigh[c] = scattered_rayleigh;
                point.scattered[c] = scattered_rayleigh + point.mie;
                tau[c] += depth;
            }
            path[taken] = point;
            taken += 1;
        }
        let ground0 = math::exp(-tau[0]) * (self.p.albedo / PI);
        let ground1 = math::exp(-tau[1]) * (self.p.albedo / PI);
        let ground2 = math::exp(-tau[2]) * (self.p.albedo / PI);
        for (k, input_nu) in nus.iter().enumerate() {
            let nu = cosine(*input_nu);
            let mu_sun = if entered {
                (r0 * mu_sun_line + enter * nu) / RT
            } else {
                mu_sun_line
            };
            let phase_rayleigh = rayleigh_phase(nu);
            let phase_mie = mie_phase(nu);
            let mut values = [0.0; 3];
            for point in &path[..taken] {
                let middle_mu_sun = cosine((r * mu_sun + point.middle * nu) / point.radius);
                let sun = self.sun_transmittance(point.radius, middle_mu_sun);
                let psi = self.multiple_at(point.radius, middle_mu_sun);
                for c in 0..3 {
                    values[c] += ((point.rayleigh[c] * phase_rayleigh + point.mie * phase_mie)
                        * sun[c]
                        + point.scattered[c] * psi[c])
                        * point.reaching[c];
                }
            }
            if hits_ground {
                let ground_mu_sun = cosine((r * mu_sun + length * nu) / RG);
                let sun = self.sun_transmittance(RG, ground_mu_sun);
                let ground = self.ground_at(ground_mu_sun);
                let direct = max(0.0, ground_mu_sun);
                values[0] += ground0 * (sun[0] * direct + ground[0]);
                values[1] += ground1 * (sun[1] * direct + ground[1]);
                values[2] += ground2 * (sun[2] * direct + ground[2]);
            }
            out[k * 3..k * 3 + 3].copy_from_slice(&values);
        }
    }
    pub fn irradiance(&self, altitude: f64, mu_sun: f64) -> [f64; 3] {
        let mut out = [0.0; 3];
        let sin_sun = math::sqrt(max(0.0, 1.0 - mu_sun * mu_sun));
        let step = (PI / 2.0) / 12.0;
        let mut nus = [0.0; 16];
        let mut ring = [0.0; 48];
        let mut path = [PathStep::ZERO; 16];
        for i in 0..12 {
            let theta = (i as f64 + 0.5) * step;
            let mu = math::cos(theta);
            let sin_view = math::sin(theta);
            let weight = mu * sin_view * step * (2.0 * PI / 16.0);
            for (j, value) in nus.iter_mut().enumerate() {
                let phi = ((j as f64 + 0.5) / 16.0) * PI;
                *value = mu * mu_sun + sin_view * sin_sun * math::cos(phi);
            }
            self.fan(altitude, mu, mu_sun, &nus, 16, &mut path, &mut ring);
            for j in 0..16 {
                out[0] += ring[j * 3] * weight;
                out[1] += ring[j * 3 + 1] * weight;
                out[2] += ring[j * 3 + 2] * weight;
            }
        }
        out
    }
}
