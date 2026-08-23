pub mod util;
pub struct Engine { pub n: u32 }
impl Engine {
    pub fn new() -> Self { Engine { n: util::math::add(1, 2) } }
    fn private_step(&self) {}
    pub fn run(&self) { self.private_step() }
}
pub trait Runner { fn go(&self); }
impl Runner for Engine { fn go(&self) { self.run() } }
