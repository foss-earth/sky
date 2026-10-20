//! The single-worker sky core: a bounded registry of buffers and models over
//! earth-sky-kernel's arithmetic, ported from sky/src/atmosphere.ts.
//! Tables may be supplied by the retained JavaScript builder or built here.
//! Arithmetic remains f64 in the reference expression order; tables retain
//! their f32 rounding. All transcendental functions import this WASM
//! instance's executing JS Math. No pointer argument is dereferenced: only
//! matching live registry allocations are accessed. This ABI is single-worker
//! and unshared; earth-sky-shared is the shared-memory build.

use earth_sky_kernel::{
    GROUND_LEN, MS_LEN, Model, Parameters, PathStep, TRANS_LEN, build_tables, valid_inputs,
};
use std::cell::RefCell;

pub use earth_sky_kernel::{MAX_DIRECTIONS, MAX_STEP_DIRECTIONS, MAX_STEPS, SNAPSHOT_LEN};
const MAX_BUFFERS: usize = 64;
const MAX_MODELS: usize = 8;
const MAX_BUFFER_ELEMENTS: usize = 65_536;
const MAX_LIVE_BYTES: usize = 32 * 1024 * 1024;

struct OwnedModel {
    p: Parameters,
    transmittance: Vec<f32>,
    multiple: Vec<f32>,
    ground: Vec<f32>,
}
impl OwnedModel {
    fn from_snapshot(data: &[f64]) -> Option<Self> {
        if data.len() != SNAPSHOT_LEN
            || !data.iter().all(|v| v.is_finite())
            || data[0] < 0.0
            || data[1] < 0.0
            || data[1] > 1.0
            || !data[2..].iter().all(|v| (*v as f32) as f64 == *v)
        {
            return None;
        }
        let p = Parameters::new(data[0], data[1]);
        if !p.extinction_finite() {
            return None;
        }
        Some(Self {
            p,
            transmittance: data[2..2 + TRANS_LEN].iter().map(|v| *v as f32).collect(),
            multiple: data[2 + TRANS_LEN..2 + TRANS_LEN + MS_LEN]
                .iter()
                .map(|v| *v as f32)
                .collect(),
            ground: data[2 + TRANS_LEN + MS_LEN..]
                .iter()
                .map(|v| *v as f32)
                .collect(),
        })
    }
    fn build(aerosol: f64, albedo: f64) -> Option<Self> {
        if !valid_inputs(&[aerosol, albedo]) || aerosol < 0.0 || !(0.0..=1.0).contains(&albedo) {
            return None;
        }
        let mut model = Self {
            p: Parameters::new(aerosol, albedo),
            transmittance: vec![0.0; TRANS_LEN],
            multiple: vec![0.0; MS_LEN],
            ground: vec![0.0; GROUND_LEN],
        };
        if !build_tables(
            &model.p,
            &mut model.transmittance,
            &mut model.multiple,
            &mut model.ground,
        ) {
            return None;
        }
        Some(model)
    }
    fn view(&self) -> Model<'_> {
        // The lengths are fixed at construction.
        Model::new(self.p, &self.transmittance, &self.multiple, &self.ground)
            .expect("complete tables")
    }
    fn snapshot(&self, out: &mut [f64]) {
        out[0] = self.p.aerosol;
        out[1] = self.p.albedo;
        for (output, input) in out[2..].iter_mut().zip(
            self.transmittance
                .iter()
                .chain(&self.multiple)
                .chain(&self.ground),
        ) {
            *output = *input as f64;
        }
    }
}
struct Buffer {
    data: Vec<f64>,
}
#[derive(Default)]
struct Registry {
    buffers: Vec<Buffer>,
    models: Vec<(u32, OwnedModel)>,
    next_model: u32,
    live_bytes: usize,
}
impl Registry {
    fn allocate(&mut self, len: usize) -> usize {
        let bytes = len.saturating_mul(8);
        if len == 0
            || len > MAX_BUFFER_ELEMENTS
            || self.buffers.len() >= MAX_BUFFERS
            || self
                .live_bytes
                .checked_add(bytes)
                .is_none_or(|n| n > MAX_LIVE_BYTES)
            || self.buffers.try_reserve(1).is_err()
        {
            return 0;
        }
        let mut data = Vec::new();
        if data.try_reserve_exact(len).is_err() {
            return 0;
        }
        data.resize(len, 0.0);
        let pointer = data.as_ptr() as usize;
        self.buffers.push(Buffer { data });
        self.live_bytes += bytes;
        pointer
    }
    fn buffer_index(&self, pointer: usize, len: usize) -> Option<usize> {
        self.buffers
            .iter()
            .position(|buffer| buffer.data.as_ptr() as usize == pointer && buffer.data.len() == len)
    }
    fn release(&mut self, pointer: usize, len: usize) -> u32 {
        let Some(index) = self.buffer_index(pointer, len) else {
            return 5;
        };
        self.live_bytes -= self.buffers.swap_remove(index).data.len() * 8;
        0
    }
    fn model_create(&mut self, pointer: usize, len: usize) -> u32 {
        if self.models.len() >= MAX_MODELS
            || self.next_model == u32::MAX
            || len != SNAPSHOT_LEN
            || self
                .live_bytes
                .checked_add((SNAPSHOT_LEN - 2) * 4)
                .is_none_or(|n| n > MAX_LIVE_BYTES)
            || self.models.try_reserve(1).is_err()
        {
            return 0;
        }
        let Some(index) = self.buffer_index(pointer, len) else {
            return 0;
        };
        let Some(model) = OwnedModel::from_snapshot(&self.buffers[index].data) else {
            return 0;
        };
        self.next_model += 1;
        let id = self.next_model;
        self.models.push((id, model));
        self.live_bytes += (SNAPSHOT_LEN - 2) * 4;
        id
    }
    fn model_drop(&mut self, id: u32) -> u32 {
        let Some(index) = self.models.iter().position(|(key, _)| *key == id) else {
            return 5;
        };
        self.models.swap_remove(index);
        self.live_bytes -= (SNAPSHOT_LEN - 2) * 4;
        0
    }
    fn model_build(&mut self, aerosol: f64, albedo: f64) -> u32 {
        if self.models.len() >= MAX_MODELS
            || self.next_model == u32::MAX
            || self
                .live_bytes
                .checked_add((SNAPSHOT_LEN - 2) * 4)
                .is_none_or(|n| n > MAX_LIVE_BYTES)
            || self.models.try_reserve(1).is_err()
        {
            return 0;
        }
        let Some(model) = OwnedModel::build(aerosol, albedo) else {
            return 0;
        };
        self.next_model += 1;
        let id = self.next_model;
        self.models.push((id, model));
        self.live_bytes += (SNAPSHOT_LEN - 2) * 4;
        id
    }
    fn model_snapshot(&mut self, id: u32, output: usize, len: usize) -> u32 {
        if len != SNAPSHOT_LEN {
            return 3;
        }
        let Some(index) = self.buffer_index(output, len) else {
            return 5;
        };
        let Some((_, model)) = self.models.iter().find(|(key, _)| *key == id) else {
            return 5;
        };
        model.snapshot(&mut self.buffers[index].data);
        0
    }
    #[allow(clippy::too_many_arguments)]
    fn radiance(
        &mut self,
        id: u32,
        altitude: f64,
        mu: f64,
        mu_sun: f64,
        nu: f64,
        steps: usize,
        output: usize,
        len: usize,
    ) -> u32 {
        if !valid_inputs(&[altitude, mu, mu_sun, nu]) || steps == 0 || steps > MAX_STEPS {
            return 1;
        }
        if len != 3 {
            return 3;
        }
        let Some(index) = self.buffer_index(output, len) else {
            return 5;
        };
        let Some((_, model)) = self.models.iter().find(|(key, _)| *key == id) else {
            return 5;
        };
        self.buffers[index]
            .data
            .copy_from_slice(&model.view().radiance(altitude, mu, mu_sun, nu, steps));
        0
    }
    #[allow(clippy::too_many_arguments)]
    fn fan(
        &mut self,
        id: u32,
        altitude: f64,
        mu: f64,
        mu_sun: f64,
        input: usize,
        count: usize,
        steps: usize,
        output: usize,
        len: usize,
    ) -> u32 {
        if !valid_inputs(&[altitude, mu, mu_sun])
            || count == 0
            || count > MAX_DIRECTIONS
            || steps == 0
            || steps > MAX_STEPS
            || count * steps > MAX_STEP_DIRECTIONS
        {
            return 1;
        }
        if len != count * 3 {
            return 3;
        }
        let (Some(input_index), Some(output_index)) = (
            self.buffer_index(input, count),
            self.buffer_index(output, len),
        ) else {
            return 5;
        };
        if input_index == output_index || !valid_inputs(&self.buffers[input_index].data) {
            return 5;
        }
        let Some((_, model)) = self.models.iter().find(|(key, _)| *key == id) else {
            return 5;
        };
        let nus = self.buffers[input_index].data.clone();
        let mut path = Vec::new();
        if path.try_reserve_exact(steps).is_err() {
            return 5;
        }
        path.resize(steps, PathStep::ZERO);
        model.view().fan(
            altitude,
            mu,
            mu_sun,
            &nus,
            steps,
            &mut path,
            &mut self.buffers[output_index].data,
        );
        0
    }
    fn irradiance(
        &mut self,
        id: u32,
        altitude: f64,
        mu_sun: f64,
        output: usize,
        len: usize,
    ) -> u32 {
        if !valid_inputs(&[altitude, mu_sun]) {
            return 1;
        }
        if len != 3 {
            return 3;
        }
        let Some(index) = self.buffer_index(output, len) else {
            return 5;
        };
        let Some((_, model)) = self.models.iter().find(|(key, _)| *key == id) else {
            return 5;
        };
        self.buffers[index]
            .data
            .copy_from_slice(&model.view().irradiance(altitude, mu_sun));
        0
    }
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }
#[unsafe(no_mangle)]
pub extern "C" fn sky_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_alloc_f64(len: u32) -> usize {
    REGISTRY.with(|r| {
        r.try_borrow_mut()
            .map_or(0, |mut r| r.allocate(len as usize))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_free_f64(pointer: usize, len: u32) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut()
            .map_or(5, |mut r| r.release(pointer, len as usize))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_model_create(pointer: usize, len: u32) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut()
            .map_or(0, |mut r| r.model_create(pointer, len as usize))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_model_drop(id: u32) -> u32 {
    REGISTRY.with(|r| r.try_borrow_mut().map_or(5, |mut r| r.model_drop(id)))
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_model_build(aerosol: f64, albedo: f64) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut()
            .map_or(0, |mut r| r.model_build(aerosol, albedo))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_model_snapshot(id: u32, output: usize, len: u32) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut()
            .map_or(5, |mut r| r.model_snapshot(id, output, len as usize))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_radiance(
    id: u32,
    altitude: f64,
    mu: f64,
    mu_sun: f64,
    nu: f64,
    steps: u32,
    output: usize,
    len: u32,
) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut().map_or(5, |mut r| {
            r.radiance(
                id,
                altitude,
                mu,
                mu_sun,
                nu,
                steps as usize,
                output,
                len as usize,
            )
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_radiance_fan(
    id: u32,
    altitude: f64,
    mu: f64,
    mu_sun: f64,
    input: usize,
    count: u32,
    steps: u32,
    output: usize,
    len: u32,
) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut().map_or(5, |mut r| {
            r.fan(
                id,
                altitude,
                mu,
                mu_sun,
                input,
                count as usize,
                steps as usize,
                output,
                len as usize,
            )
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn sky_irradiance(
    id: u32,
    altitude: f64,
    mu_sun: f64,
    output: usize,
    len: u32,
) -> u32 {
    REGISTRY.with(|r| {
        r.try_borrow_mut().map_or(5, |mut r| {
            r.irradiance(id, altitude, mu_sun, output, len as usize)
        })
    })
}
