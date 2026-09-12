/**
 * WinIsland 同款弹簧（照搬 `src/utils/physics.rs` 与 `src/window/app/frame.rs` 的参数与更新式）。
 *
 * 原始实现（Rust，每帧调用一次，`dt` 以**帧**为单位）：
 * ```text
 * force    = (target - value) * stiffness * dt
 * velocity = (velocity + force) * damping^dt
 * value   += velocity * dt
 * ```
 * 主岛尺寸用的参数：`stiffness = 0.10`、`damping = 0.68`（阻尼比 ζ≈0.977，接近临界阻尼，
 * 理论过冲 ~1e-6，肉眼不可见）。换向时还有两个限制（`redirect_velocity_towards`）：
 * 反向动量只保留 35%、单帧位移不超过剩余距离的 20%。
 *
 * 我们在此基础上**额外加了零过冲钳制**（越过目标立刻吸附并清零速度）：
 * 即便某帧卡顿导致 dt 变大，也绝不会出现"超过目标再弹回来"的震动。
 */
export interface SpringOptions {
  /** 刚度（WinIsland 主岛尺寸：0.10） */
  stiffness?: number;
  /** 速度保留率（WinIsland 主岛尺寸：0.68） */
  damping?: number;
  /** 吸附阈值（px） */
  snapThreshold?: number;
}

const MOMENTUM_RETENTION = 0.35;
const MAX_DISTANCE_RATIO = 0.2;
const MAX_DT = 6;
/** 一帧按 60fps 折算（与 WinIsland 的 dt 单位一致） */
const FRAME_MS = 1000 / 60;

export class SpringValue {
  value: number;
  velocity = 0;
  target: number;

  private readonly stiffness: number;
  private readonly damping: number;
  private readonly snapThreshold: number;

  constructor(initial: number, options: SpringOptions = {}) {
    this.value = initial;
    this.target = initial;
    this.stiffness = options.stiffness ?? 0.1;
    this.damping = options.damping ?? 0.68;
    this.snapThreshold = options.snapThreshold ?? 0.05;
  }

  setTarget(target: number): void {
    if (target === this.target) return;
    this.redirectVelocity(target);
    this.target = target;
  }

  /** 直接落位（关闭动画 / 首次同步时使用） */
  snap(target: number): void {
    this.target = target;
    this.value = target;
    this.velocity = 0;
  }

  get settled(): boolean {
    return Math.abs(this.target - this.value) <= this.snapThreshold && Math.abs(this.velocity) <= 0.01;
  }

  /**
   * 换向限速（WinIsland）：反向时只保留 35% 动量，并把速度幅值限制在"剩余距离的 20%"以内，
   * 保证不会因为方向切换产生突跳。
   */
  private redirectVelocity(target: number): void {
    const distance = target - this.value;
    if (distance === 0) {
      this.velocity = 0;
      return;
    }
    const sameDirection = Math.sign(distance) === Math.sign(this.velocity);
    if (!sameDirection) this.velocity *= MOMENTUM_RETENTION;
    const maxVelocity = Math.abs(distance) * MAX_DISTANCE_RATIO;
    if (Math.abs(this.velocity) > maxVelocity) {
      this.velocity = Math.sign(this.velocity) * maxVelocity;
    }
  }

  /** 推进一帧；返回是否仍在运动 */
  step(deltaMs: number): boolean {
    const dt = Math.min(MAX_DT, Math.max(0.1, deltaMs / FRAME_MS));
    const distance = this.target - this.value;
    if (distance === 0 && Math.abs(this.velocity) <= 0.01) {
      this.velocity = 0;
      this.value = this.target;
      return false;
    }

    const force = distance * this.stiffness * dt;
    this.velocity = (this.velocity + force) * Math.pow(this.damping, dt);

    const previous = this.value;
    this.value += this.velocity * dt;

    // 零过冲钳制：越过目标（或已足够接近）就吸附到目标并停止
    const crossed = (this.target - previous) * (this.target - this.value) <= 0;
    if (crossed || Math.abs(this.target - this.value) <= this.snapThreshold) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }

    if (!Number.isFinite(this.value) || !Number.isFinite(this.velocity)) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}
