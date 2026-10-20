//! The shared-memory sky core: one module instantiated by a coordinator and
//! its helper workers over one imported shared `WebAssembly.Memory`.
//!
//! No allocator, no thread-local storage and no locks: every buffer is a fixed
//! static arena, so instances never share allocator or handle state. Each
//! instance owns a 64 KiB slot of the linker's stack, set by its host through
//! the exported `__stack_pointer` before every call. The only cross-thread
//! state is the control block's sequentially consistent i32 words, which the
//! JS hosts also access with `Atomics`.
//!
//! A batch of radiance fans (one per row) is published by the coordinator;
//! every participant validates the whole descriptor, then claims rows from an
//! atomic counter until none are left. Rows are independent and each one is
//! computed by exactly one thread with the single core's arithmetic, so the
//! output is the same whichever thread computes a row and however many join.
#![cfg_attr(target_arch = "wasm32", no_std)]

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicI32, Ordering::SeqCst};
use earth_sky_kernel::{
    GROUND_LEN, MAX_DIRECTIONS, MAX_STEP_DIRECTIONS, MAX_STEPS, MS_LEN, Model, Parameters,
    PathStep, TRANS_LEN, build_tables, valid_inputs,
};

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

pub const ABI_VERSION: u32 = 1;
pub const MAX_THREADS: usize = 8;
pub const MAX_ROWS: usize = 512;
pub const MAX_NUS: usize = 65_536;
pub const MAX_SHARED_STEPS: usize = 256;

// Control words, as i32 indices; sky-WASM/threads.js mirrors them.
/// The generation last published.
pub const EPOCH: usize = 0;
/// The generation helpers may still join; 0 once the coordinator closed it.
pub const OPEN: usize = 1;
/// Helpers between joining and leaving a generation.
pub const ACTIVE: usize = 2;
pub const STOP: usize = 3;
/// The next unclaimed row.
pub const CLAIM: usize = 4;
pub const ROWS_DONE: usize = 5;
/// The first failure any participant reported; 0 while none has.
pub const ERROR: usize = 6;
/// READY + t: helper t is initialised and waiting.
pub const READY: usize = 8;
/// ROWS_BY + t: rows thread t computed in the current generation.
pub const ROWS_BY: usize = 16;
pub const CONTROL_WORDS: usize = 32;

pub const OK: u32 = 0;
pub const INVALID: u32 = 1;
pub const NO_MODEL: u32 = 2;
pub const CAPACITY: u32 = 3;
pub const THREAD: u32 = 4;

#[repr(C)]
pub struct Job {
    altitude: f64,
    mu_sun: f64,
    rows: u32,
    steps: u32,
    nus: u32,
    model: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Row {
    mu: f64,
    start: u32,
    count: u32,
}
#[repr(C)]
struct Tables {
    transmittance: [f32; TRANS_LEN],
    multiple: [f32; MS_LEN],
    ground: [f32; GROUND_LEN],
}
#[repr(C)]
struct ModelHeader {
    aerosol: f64,
    albedo: f64,
    /// 0 until a model is committed; bumped by every commit.
    generation: u32,
}

/// Static storage whose cross-thread use the control protocol orders.
#[repr(C, align(16))]
struct Shared<T>(UnsafeCell<T>);
unsafe impl<T> Sync for Shared<T> {}
impl<T> Shared<T> {
    const fn new(value: T) -> Self {
        Self(UnsafeCell::new(value))
    }
    fn get(&self) -> *mut T {
        self.0.get()
    }
}

static CONTROL: [AtomicI32; CONTROL_WORDS] = [const { AtomicI32::new(0) }; CONTROL_WORDS];
static JOB: Shared<Job> = Shared::new(Job {
    altitude: 0.0,
    mu_sun: 0.0,
    rows: 0,
    steps: 0,
    nus: 0,
    model: 0,
});
static ROWS: Shared<[Row; MAX_ROWS]> = Shared::new(
    [Row {
        mu: 0.0,
        start: 0,
        count: 0,
    }; MAX_ROWS],
);
static NUS: Shared<[f64; MAX_NUS]> = Shared::new([0.0; MAX_NUS]);
static OUT: Shared<[f64; MAX_NUS * 3]> = Shared::new([0.0; MAX_NUS * 3]);
static SCRATCH: Shared<[[PathStep; MAX_SHARED_STEPS]; MAX_THREADS]> =
    Shared::new([[PathStep::ZERO; MAX_SHARED_STEPS]; MAX_THREADS]);
static TABLES: Shared<Tables> = Shared::new(Tables {
    transmittance: [0.0; TRANS_LEN],
    multiple: [0.0; MS_LEN],
    ground: [0.0; GROUND_LEN],
});
static MODEL: Shared<ModelHeader> = Shared::new(ModelHeader {
    aerosol: 0.0,
    albedo: 0.0,
    generation: 0,
});
static RESULT: Shared<[f64; 3]> = Shared::new([0.0; 3]);

fn fail(code: u32) -> u32 {
    let _ = CONTROL[ERROR].compare_exchange(0, code as i32, SeqCst, SeqCst);
    code
}

/// The committed model, read-only. Only the coordinator commits, and never
/// while a generation is open.
fn model() -> Option<Model<'static>> {
    // SAFETY: tables and header are written only by the coordinator between
    // generations; participants read them while it waits.
    unsafe {
        let header = &*MODEL.get();
        if header.generation == 0 {
            return None;
        }
        let tables = &*TABLES.get();
        Model::new(
            Parameters::new(header.aerosol, header.albedo),
            &tables.transmittance,
            &tables.multiple,
            &tables.ground,
        )
    }
}

fn valid_parameters(aerosol: f64, albedo: f64) -> bool {
    valid_inputs(&[aerosol, albedo])
        && aerosol >= 0.0
        && (0.0..=1.0).contains(&albedo)
        && Parameters::new(aerosol, albedo).extinction_finite()
}

/// A copy of the published job after checking everything a row will touch.
fn validated() -> Result<Job, u32> {
    // SAFETY: the job, rows and directions are written by the coordinator
    // before it publishes a generation and are not written while it is open.
    let job = unsafe { core::ptr::read(JOB.get()) };
    let generation = unsafe { (*MODEL.get()).generation };
    if generation == 0 || job.model != generation {
        return Err(NO_MODEL);
    }
    let rows = job.rows as usize;
    let steps = job.steps as usize;
    let nus = job.nus as usize;
    if !valid_inputs(&[job.altitude, job.mu_sun]) {
        return Err(INVALID);
    }
    if rows == 0 || rows > MAX_ROWS || steps == 0 || steps > MAX_SHARED_STEPS || nus > MAX_NUS {
        return Err(CAPACITY);
    }
    let table = unsafe { core::slice::from_raw_parts(ROWS.get() as *const Row, rows) };
    let mut end = 0usize;
    for row in table {
        let count = row.count as usize;
        if row.start as usize != end
            || count == 0
            || count > MAX_DIRECTIONS
            || count * steps > MAX_STEP_DIRECTIONS
            || !valid_inputs(&[row.mu])
        {
            return Err(INVALID);
        }
        end += count;
    }
    let directions = unsafe { core::slice::from_raw_parts(NUS.get() as *const f64, nus) };
    if end != nus || !valid_inputs(directions) {
        return Err(INVALID);
    }
    Ok(job)
}

#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_abi_version() -> u32 {
    ABI_VERSION
}

/// Addresses and capacities the hosts need; 0 for an unknown field.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_layout(field: u32) -> u32 {
    (match field {
        0 => CONTROL.as_ptr() as usize,
        1 => JOB.get() as usize,
        2 => ROWS.get() as usize,
        3 => NUS.get() as usize,
        4 => OUT.get() as usize,
        5 => unsafe { (&raw const (*TABLES.get()).transmittance) as usize },
        6 => unsafe { (&raw const (*TABLES.get()).multiple) as usize },
        7 => unsafe { (&raw const (*TABLES.get()).ground) as usize },
        8 => RESULT.get() as usize,
        9 => MAX_THREADS,
        10 => MAX_ROWS,
        11 => MAX_NUS,
        12 => MAX_SHARED_STEPS,
        13 => CONTROL_WORDS,
        14 => core::mem::size_of::<Job>(),
        15 => core::mem::size_of::<Row>(),
        _ => 0,
    }) as u32
}

/// Coordinator only, between generations: builds the tables here.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_build(aerosol: f64, albedo: f64) -> u32 {
    if !valid_parameters(aerosol, albedo) {
        return INVALID;
    }
    // SAFETY: no generation is open, so no participant reads the tables.
    unsafe {
        let header = &mut *MODEL.get();
        header.generation = 0;
        let tables = &mut *TABLES.get();
        let p = Parameters::new(aerosol, albedo);
        if !build_tables(
            &p,
            &mut tables.transmittance,
            &mut tables.multiple,
            &mut tables.ground,
        ) {
            return INVALID;
        }
        commit(header, aerosol, albedo)
    }
}

/// Coordinator only, between generations: admits tables the host wrote.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_commit(aerosol: f64, albedo: f64) -> u32 {
    if !valid_parameters(aerosol, albedo) {
        return INVALID;
    }
    // SAFETY: as for sky_shared_build.
    unsafe {
        let header = &mut *MODEL.get();
        header.generation = 0;
        let tables = &*TABLES.get();
        if !tables
            .transmittance
            .iter()
            .chain(&tables.multiple)
            .chain(&tables.ground)
            .all(|v| v.is_finite())
        {
            return INVALID;
        }
        commit(header, aerosol, albedo)
    }
}

/// The generation the next job names; never 0.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_model() -> u32 {
    unsafe { (*MODEL.get()).generation }
}

fn commit(header: &mut ModelHeader, aerosol: f64, albedo: f64) -> u32 {
    static NEXT: Shared<u32> = Shared::new(0);
    // SAFETY: coordinator only.
    let next = unsafe { &mut *NEXT.get() };
    *next = if *next == u32::MAX { 1 } else { *next + 1 };
    header.aerosol = aerosol;
    header.albedo = albedo;
    header.generation = *next;
    OK
}

/// Coordinator only: one sample of `Atmosphere.radiance` into the result.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_radiance(
    altitude: f64,
    mu: f64,
    mu_sun: f64,
    nu: f64,
    steps: u32,
) -> u32 {
    let steps = steps as usize;
    if !valid_inputs(&[altitude, mu, mu_sun, nu]) || steps == 0 || steps > MAX_STEPS {
        return INVALID;
    }
    let Some(model) = model() else {
        return NO_MODEL;
    };
    let value = model.radiance(altitude, mu, mu_sun, nu, steps);
    unsafe { *RESULT.get() = value };
    OK
}

/// Coordinator only: `Atmosphere.skyIrradiance` into the result.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_irradiance(altitude: f64, mu_sun: f64) -> u32 {
    if !valid_inputs(&[altitude, mu_sun]) {
        return INVALID;
    }
    let Some(model) = model() else {
        return NO_MODEL;
    };
    let value = model.irradiance(altitude, mu_sun);
    unsafe { *RESULT.get() = value };
    OK
}

/// Coordinator only, before publishing: checks the job it wrote and resets
/// the generation's counters.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_prepare() -> u32 {
    if let Err(code) = validated() {
        return code;
    }
    CONTROL[CLAIM].store(0, SeqCst);
    CONTROL[ROWS_DONE].store(0, SeqCst);
    CONTROL[ERROR].store(0, SeqCst);
    for t in 0..MAX_THREADS {
        CONTROL[ROWS_BY + t].store(0, SeqCst);
    }
    OK
}

/// Any participant: validates the published job, then computes rows until
/// none are left. Thread `thread` uses its own path scratch.
#[unsafe(no_mangle)]
pub extern "C" fn sky_shared_fan_claimed(thread: u32) -> u32 {
    let thread = thread as usize;
    if thread >= MAX_THREADS {
        return fail(THREAD);
    }
    let job = match validated() {
        Ok(job) => job,
        Err(code) => return fail(code),
    };
    let Some(model) = model() else {
        return fail(NO_MODEL);
    };
    let rows = job.rows as i32;
    let steps = job.steps as usize;
    // SAFETY: each thread index has one participant, and the scratch is its alone.
    let path = unsafe { &mut *(SCRATCH.get() as *mut [PathStep; MAX_SHARED_STEPS]).add(thread) };
    loop {
        if CONTROL[ERROR].load(SeqCst) != 0 {
            return OK;
        }
        let claimed = CONTROL[CLAIM].fetch_add(1, SeqCst);
        if claimed < 0 || claimed >= rows {
            return OK;
        }
        // SAFETY: the claim makes this row's output range this thread's alone;
        // the validated rows are contiguous and within MAX_NUS.
        let row = unsafe { *(ROWS.get() as *const Row).add(claimed as usize) };
        let start = row.start as usize;
        let count = row.count as usize;
        let nus =
            unsafe { core::slice::from_raw_parts((NUS.get() as *const f64).add(start), count) };
        let out = unsafe {
            core::slice::from_raw_parts_mut((OUT.get() as *mut f64).add(start * 3), count * 3)
        };
        model.fan(
            job.altitude,
            row.mu,
            job.mu_sun,
            nus,
            steps,
            &mut path[..],
            out,
        );
        CONTROL[ROWS_BY + thread].fetch_add(1, SeqCst);
        CONTROL[ROWS_DONE].fetch_add(1, SeqCst);
    }
}
