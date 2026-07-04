import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/**
 * Parallax factors. 0 = fixed, 1 = scrolls at page speed.
 * Slower factors = deeper layers, gives the hero a sense of depth.
 */
const STARS_BACK_FACTOR    = 0.10  // tiny far-away stars, barely move
const STARS_MID_FACTOR     = 0.20  // mid-depth stars
const STARS_FRONT_FACTOR   = 0.30  // larger near stars (behind image)
const IMAGE_FACTOR         = 0.18  // gentle drift — keeps the full image in-frame
const STARS_OVERLAY_FACTOR = 0.55  // fastest layer — sits OVER the image, top half only

// Hand-picked star positions across a 1600×900 layer. Each layer is split into
// three stride-3 chunks so the stars can run independent animations without
// the field pulsing in sync.
// Curated positions across a 1600×900 layer. Right side (x > 1100) is
// intentionally denser — gives the constellation more weight on the side
// opposite the operators in the image.
const STARS_BACK_RAW = [
  '40px 80px', '180px 220px', '320px 60px', '510px 410px', '720px 130px',
  '880px 530px', '1050px 90px', '1200px 320px', '1380px 470px', '1520px 200px',
  '60px 580px', '230px 700px', '410px 850px', '600px 760px', '790px 660px',
  '950px 820px', '1100px 700px', '1260px 880px', '1430px 760px', '1580px 870px',
  '95px 310px', '260px 410px', '475px 250px', '640px 50px', '835px 285px',
  '1010px 245px', '1175px 540px', '1340px 110px', '1490px 600px', '1545px 380px',
  // Extra right-side stars
  '1180px 165px', '1265px 60px',  '1325px 215px', '1410px 35px',  '1475px 145px',
  '1545px 95px',  '1280px 405px', '1370px 320px', '1465px 460px', '1525px 285px',
  '1595px 175px', '1320px 555px', '1430px 605px', '1490px 730px', '1565px 510px',
]

const STARS_MID_RAW = [
  '110px 150px', '300px 320px', '480px 200px', '670px 480px', '850px 80px',
  '1040px 380px', '1230px 200px', '1420px 360px', '1570px 70px',
  '80px 460px', '270px 580px', '460px 690px', '660px 820px', '850px 720px',
  '1040px 880px', '1220px 580px', '1410px 800px', '1560px 690px',
  '195px 50px', '395px 120px', '580px 350px', '770px 230px', '960px 510px',
  '1150px 110px', '1335px 470px', '1500px 280px',
  // Extra right-side stars
  '1295px 145px', '1385px 250px', '1465px 130px', '1530px 410px', '1580px 235px',
  '1260px 340px', '1450px 565px', '1525px 530px', '1340px 670px', '1295px 760px',
]

const STARS_FRONT_RAW = [
  '160px 90px', '370px 280px', '590px 130px', '790px 410px', '990px 220px',
  '1190px 90px', '1390px 470px', '1555px 240px',
  '125px 670px', '345px 800px', '535px 580px', '740px 750px', '925px 640px',
  '1115px 820px', '1310px 660px', '1500px 880px',
  '230px 350px', '450px 460px', '655px 360px', '870px 540px', '1075px 350px',
  '1265px 670px', '1470px 130px',
  // Extra right-side stars
  '1245px 195px', '1335px 90px',  '1420px 230px', '1505px 175px', '1580px 320px',
  '1305px 405px', '1395px 305px', '1465px 555px', '1540px 425px',
]

// Foreground layer — over the image, upper portion only. Most prominent of all.
const STARS_OVERLAY_RAW = [
  '215px 75px', '385px 120px', '545px 50px', '710px 165px', '880px 80px',
  '1055px 145px', '1235px 95px', '1410px 175px', '1565px 110px',
  '155px 235px', '320px 295px', '495px 215px', '670px 320px', '845px 245px',
  '1020px 280px', '1190px 235px', '1370px 305px', '1530px 215px',
  '275px 380px', '465px 360px', '630px 410px', '825px 380px', '1010px 425px',
  '1195px 395px', '1380px 440px', '1540px 395px',
  // Extra right-side stars
  '1265px 55px',  '1345px 165px', '1450px 65px',  '1500px 290px', '1590px 175px',
  '1295px 250px', '1430px 250px', '1465px 350px', '1555px 320px',
]

/** Split an array into N stride-N chunks (positions stay spatially distributed). */
function strideChunks<T>(arr: T[], n: number): T[][] {
  return Array.from({ length: n }, (_, i) => arr.filter((_, j) => j % n === i))
}

function shadow(positions: string[]): string {
  return positions.map((p) => `${p} #ffffff`).join(', ')
}

/**
 * Tile a star-position array horizontally so the field covers ultrawide
 * viewports. Base positions live in a ~1600px-wide layer; we repeat them N
 * times shifted by `tileW`, with a deterministic Y jitter per tile so the
 * repetition is invisible to the eye.
 */
function tileWide(positions: string[], tiles = 3, tileW = 1700, yJitter = 40): string[] {
  const out: string[] = []
  for (let t = 0; t < tiles; t++) {
    for (const p of positions) {
      const [xRaw, yRaw] = p.split(' ')
      const x = parseInt(xRaw, 10) + t * tileW
      // Pseudorandom jitter from tile index + base coord — stable, breaks the grid.
      const dy = ((t * 53 + parseInt(xRaw, 10) * 7) % (yJitter * 2)) - yJitter
      const y = parseInt(yRaw, 10) + dy
      out.push(`${x}px ${y}px`)
    }
  }
  return out
}

/**
 * Each star layer gets three "ambient" sub-groups + a list of "shine" stars.
 * Ambient stars are dim and rendered via box-shadow (one div = many stars,
 * cheap). Shine stars are rendered as individual divs so each can wear its
 * own pulsing box-shadow halo — `filter: drop-shadow` doesn't work on
 * box-shadow-rendered stars because the filter region is clipped to the
 * element's box, leaving far-away box-shadows un-glowed.
 */
type SubGroup = { shadow: string; cls: string; delay: string }
type ShineStar = { x: string; y: string; delay: string; variant: 'cool' | 'warm' }

const SHINE_DELAYS = ['0s', '2.7s', '5.4s', '8.1s', '10.8s', '1.3s', '4.0s', '6.7s', '9.4s', '12.1s']

function parsePos(p: string): { x: string; y: string } {
  const [x, y] = p.split(' ')
  return { x, y }
}

function makeLayer(raw: string[]): { subs: SubGroup[]; shineStars: ShineStar[] } {
  // Shine stars come from the ORIGINAL un-tiled positions only — keeps the
  // bright flares centred where the user's gaze lives, not way out at the
  // edge of a 3440-pixel monitor.
  const baseShine = [raw[0], raw[5], raw[12], raw[18], raw[3], raw[10]].filter(Boolean)
  const baseShineSet = new Set(baseShine)

  // Tile the ambient (non-shine) stars to cover ultrawide viewports.
  const ambient = raw.filter((p) => !baseShineSet.has(p))
  const tiledAmbient = tileWide(ambient)
  const [a, b, c] = strideChunks(tiledAmbient, 3)

  const shineStars: ShineStar[] = baseShine.map((pos, i) => ({
    ...parsePos(pos),
    delay:   SHINE_DELAYS[i % SHINE_DELAYS.length],
    variant: i % 3 === 0 ? 'warm' : 'cool',
  }))

  return {
    subs: [
      { shadow: shadow(a), cls: 'animate-twinkle-a', delay: '0s'   },
      { shadow: shadow(b), cls: 'animate-twinkle-b', delay: '2.4s' },
      { shadow: shadow(c), cls: 'animate-twinkle-c', delay: '5.1s' },
    ],
    shineStars,
  }
}

// Each shooting star carries its own randomised path. Spawned on a long,
// random interval (one every ~7-15s) so the sky stays calm — but every once
// in a while a streak shoots across.
//
// Spawn region is constrained to the LEFT or RIGHT sky band — the horizontal
// fade regions of the hero image where the dark background shows through.
// The streaks sit at -z-[5] (above the starfields, behind the image), so they
// wouldn't be visible in the opaque middle anyway; we just don't waste them there.
type ShootingStar = {
  id: number
  x: number        // start position in PIXELS — viewport-aware
  y: number        // start position in PIXELS
  angle: number    // rotation in degrees — drives translateX direction
  distance: number // px the streak travels along its rotated +x axis
  duration: number // ms the animation lasts
}

/**
 * Renders one shooting star and animates it via the Web Animations API.
 *
 * Why WAAPI instead of a CSS @keyframes shoot? Because CSS keyframes that
 * reference custom properties inside `transform` only interpolate cleanly
 * when those props are registered via @property — and even then a few
 * browsers misbehave when the function list contains a `var()`. Passing
 * the literal transform strings to element.animate() side-steps all of it.
 */
function ShootingStarEl({ s, cls = 'shooting-star' }: { s: ShootingStar; cls?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof el.animate !== 'function') return
    const anim = el.animate(
      [
        { transform: `rotate(${s.angle}deg) translateX(0px)`,             opacity: 0, offset: 0    },
        { transform: `rotate(${s.angle}deg) translateX(${s.distance * 0.10}px)`, opacity: 1, offset: 0.10 },
        { transform: `rotate(${s.angle}deg) translateX(${s.distance * 0.85}px)`, opacity: 1, offset: 0.85 },
        { transform: `rotate(${s.angle}deg) translateX(${s.distance}px)`, opacity: 0, offset: 1    },
      ],
      { duration: s.duration, easing: 'cubic-bezier(0.25, 0.05, 0.4, 1)', fill: 'forwards' },
    )
    return () => anim.cancel()
  }, [s])
  return (
    <span
      ref={ref}
      className={`${cls} absolute`}
      style={{ left: `${s.x}px`, top: `${s.y}px`, opacity: 0 }}
    />
  )
}

// ── Hero headline typewriter ─────────────────────────────────────────
// The second headline line is typed and deleted like a terminal prompt —
// one rotating sovereignty statement in the big gradient type.
const TYPED_PHRASES = [
  'Command Your Data.',
  'Stay Sovereign.',
  'Own Your Data.',
]

function useTypewriter(phrases: string[]) {
  // The first phrase is fully rendered from the very first paint — the page
  // never loads with an empty headline. Rotation (delete → type next) only
  // starts after an initial hold.
  const [text, setText] = useState(phrases[0])
  useEffect(() => {
    // Reduced motion → static first phrase, no churn.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    let phrase = 0
    let len = phrases[0].length
    let deleting = true // first tick starts deleting the pre-rendered phrase
    let timer: number | undefined
    const tick = () => {
      const current = phrases[phrase]
      if (!deleting) {
        len++
        setText(current.slice(0, len))
        if (len === current.length) {
          deleting = true
          timer = window.setTimeout(tick, 2600) // hold the finished phrase
          return
        }
        timer = window.setTimeout(tick, 46 + Math.random() * 48) // human-ish typing
      } else {
        len--
        setText(current.slice(0, len))
        if (len === 0) {
          deleting = false
          phrase = (phrase + 1) % phrases.length
          timer = window.setTimeout(tick, 450)
          return
        }
        timer = window.setTimeout(tick, 24)
      }
    }
    timer = window.setTimeout(tick, 2600) // hold the initial phrase first
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return text
}

const INSTALL_CMD = 'curl -fsSL https://gctrl.tech/install | bash'

export function HeroSection() {
  const [scrollY, setScrollY] = useState(0)
  const [shooters, setShooters] = useState<ShootingStar[]>([])
  const [frontShooters, setFrontShooters] = useState<ShootingStar[]>([])
  const [copied, setCopied] = useState(false)
  const rafRef = useRef<number | null>(null)
  const shooterIdRef = useRef(0)
  const copyTimerRef = useRef<number | null>(null)
  const typed = useTypewriter(TYPED_PHRASES)

  // Scroll parallax is continuous work (rAF-throttled setState on every
  // scroll frame, driving translate3d on 5 layered elements) — mobile GPUs
  // feel this as jank. Disable it under prefers-reduced-motion (mirrors the
  // typewriter/shooting-star guards above) AND on small viewports, where the
  // effect is barely visible anyway. Reacts live to OS setting changes and to
  // viewport size crossing the breakpoint (e.g. rotation).
  const [parallaxEnabled, setParallaxEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    return (
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      !window.matchMedia('(max-width: 640px)').matches
    )
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const mobileQuery = window.matchMedia('(max-width: 640px)')
    const update = () => setParallaxEnabled(!reduceMotionQuery.matches && !mobileQuery.matches)
    update()
    reduceMotionQuery.addEventListener('change', update)
    mobileQuery.addEventListener('change', update)
    return () => {
      reduceMotionQuery.removeEventListener('change', update)
      mobileQuery.removeEventListener('change', update)
    }
  }, [])

  useEffect(() => {
    if (!parallaxEnabled) {
      // Freeze all layers at their rest position instead of leaving them
      // stuck at whatever scroll offset was last recorded.
      setScrollY(0)
      return
    }
    const onScroll = () => {
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(() => {
        setScrollY(window.scrollY)
        rafRef.current = null
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [parallaxEnabled])

  // Shooting-star spawner. Respects prefers-reduced-motion. Each star is
  // self-cleaning — removed from state after its animation completes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let cancelled = false
    let nextTimer: number | undefined
    let cleanupTimers: number[] = []

    const spawn = () => {
      if (cancelled) return
      const id = shooterIdRef.current++
      const vw = window.innerWidth
      const vh = window.innerHeight

      // Estimate the sky band width on each side of the hero image. The image
      // is h-full w-auto with intrinsic ratio 1.86 — band width = (vw - vh*1.86)/2.
      // On ultrawide the bands are huge; on 16:9 they're thin or even 0.
      const imageW = Math.min(vh * 1.86, vw)
      const bandW = Math.max(120, (vw - imageW) / 2)

      // Streaks must stay in the hero's upper half — the lower half of the
      // image reads as "ground", and a meteor passing in front of the ground
      // looks wrong. Spawn high and cap the travel distance so the head
      // never sinks below ~48% of the viewport height.
      const y = 40 + Math.random() * (vh * 0.12)
      const useRight = Math.random() < 0.5
      const angle = useRight
        ? 128 + Math.random() * 22 // 128°-150° → down-left
        : 30 + Math.random() * 22  // 30°-52° → down-right
      const maxDrop = Math.max(60, vh * 0.48 - y)
      // Distance scales with the band so the streak actually crosses the
      // visible sky — clamped by the vertical budget above.
      const dist = Math.min(
        280 + Math.random() * Math.min(bandW * 0.7, 500),
        maxDrop / Math.abs(Math.sin((angle * Math.PI) / 180)),
      )

      const star: ShootingStar = {
        id,
        x: useRight
          ? vw - 220 + Math.random() * 120 // head ~100-220px from right edge
          : -170 + Math.random() * 100,    // head ~0-100px past the left edge
        y,
        angle,
        distance: dist,
        duration: 1500 + Math.random() * 700,
      }

      setShooters((s) => [...s, star])
      const cleanup = window.setTimeout(() => {
        setShooters((s) => s.filter((x) => x.id !== id))
      }, star.duration + 200)
      cleanupTimers.push(cleanup)

      nextTimer = window.setTimeout(spawn, 4500 + Math.random() * 5500)
    }

    nextTimer = window.setTimeout(spawn, 1200 + Math.random() * 2500)
    return () => {
      cancelled = true
      if (nextTimer) window.clearTimeout(nextTimer)
      cleanupTimers.forEach((t) => window.clearTimeout(t))
    }
  }, [])

  // Rare LONG shooting star — sweeps across the WHOLE hero width, behind the
  // image (-z-[5]): it disappears behind the building and re-emerges on the
  // other side. Deliberately infrequent (~every 14-26s) so it stays a small
  // event rather than becoming noise.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let cancelled = false
    let nextTimer: number | undefined
    const cleanupTimers: number[] = []

    const spawn = () => {
      if (cancelled) return
      const id = shooterIdRef.current++
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Same upper-half rule as the edge streaks: spawn high, then flatten
      // the sweep angle so that even after crossing the full viewport width
      // the head never sinks below ~45% of the viewport height.
      const y = vh * 0.05 + Math.random() * vh * 0.15
      const distance = vw + 750 // fully crosses the viewport
      const maxDrop = Math.max(40, vh * 0.45 - y)
      const maxAngle = (Math.asin(Math.min(1, maxDrop / distance)) * 180) / Math.PI
      const star: ShootingStar = {
        id,
        x: -320,
        y,
        angle: Math.max(2, Math.min(6 + Math.random() * 8, maxAngle)), // shallow down-right sweep
        distance,
        duration: 2300 + Math.random() * 900,
      }
      setFrontShooters((s) => [...s, star])
      cleanupTimers.push(
        window.setTimeout(() => {
          setFrontShooters((s) => s.filter((x) => x.id !== id))
        }, star.duration + 200),
      )
      nextTimer = window.setTimeout(spawn, 14000 + Math.random() * 12000)
    }

    nextTimer = window.setTimeout(spawn, 5000 + Math.random() * 6000)
    return () => {
      cancelled = true
      if (nextTimer) window.clearTimeout(nextTimer)
      cleanupTimers.forEach((t) => window.clearTimeout(t))
    }
  }, [])

  // Memoised once — pure string work, but no need to redo per render.
  const back    = useMemo(() => makeLayer(STARS_BACK_RAW),    [])
  const mid     = useMemo(() => makeLayer(STARS_MID_RAW),     [])
  const front   = useMemo(() => makeLayer(STARS_FRONT_RAW),   [])
  const overlay = useMemo(() => makeLayer(STARS_OVERLAY_RAW), [])

  const renderStarLayer = (
    layer: { subs: SubGroup[]; shineStars: ShineStar[] },
    factor: number,
    extra: { zClass: string; dotSize: string; heightClass: string; shineSize: string },
  ) => (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 top-0 ${extra.heightClass} ${extra.zClass} overflow-hidden`}
      style={{
        transform: `translate3d(0, ${scrollY * factor}px, 0)`,
        willChange: 'transform',
      }}
    >
      {/* Ambient stars — many positions packed into one box-shadow string */}
      {layer.subs.map((s, i) => (
        <div
          key={i}
          className={`absolute left-0 top-0 ${extra.dotSize} ${s.cls} rounded-full`}
          style={{ boxShadow: s.shadow, animationDelay: s.delay }}
        />
      ))}
      {/* Shine stars — each is its own div so its animated box-shadow halo
          glows around the star directly (no filter-region clipping issues). */}
      {layer.shineStars.map((s, i) => (
        <div
          key={`shine-${i}`}
          className={`absolute ${extra.shineSize} rounded-full bg-white ${
            s.variant === 'warm' ? 'animate-twinkle-shine-warm' : 'animate-twinkle-shine'
          }`}
          style={{ left: s.x, top: s.y, animationDelay: s.delay }}
        />
      ))}
    </div>
  )

  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#020617] px-6 pt-20">
      {/* ── Background starfields (3 depths) — sit behind everything ──────── */}
      {renderStarLayer(back,  STARS_BACK_FACTOR,  { zClass: '-z-10', dotSize: 'h-[1px] w-[1px]',     shineSize: 'h-[3px] w-[3px]', heightClass: 'h-[180vh]' })}
      {renderStarLayer(mid,   STARS_MID_FACTOR,   { zClass: '-z-10', dotSize: 'h-[1.5px] w-[1.5px]', shineSize: 'h-[3px] w-[3px]', heightClass: 'h-[180vh]' })}
      {renderStarLayer(front, STARS_FRONT_FACTOR, { zClass: '-z-10', dotSize: 'h-[2px] w-[2px]',     shineSize: 'h-[4px] w-[4px]', heightClass: 'h-[180vh]' })}

      {/* ── Hero image — full ratio visible, dissolves smoothly into the bg ── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0 flex items-center justify-center"
        style={{
          transform: `translate3d(0, ${scrollY * IMAGE_FACTOR}px, 0)`,
          willChange: 'transform',
        }}
      >
        <img
          src="/hero-bg.png"
          alt=""
          // h-full w-auto → the <img> bounding box matches the image's
          // intrinsic aspect ratio (1711×919). No letterboxing, so the mask
          // gradient stops fall exactly on the image's actual left/right
          // edges instead of inside an empty container margin.
          className="h-full w-auto max-w-none"
          style={{
            // Middle 56% of the image stays at full opacity. Only the outer
            // 22% on each side fades out. The fade itself is multi-stop with
            // an ease-out curve (slow start, accelerating into transparent)
            // so the ramp feels organic instead of like a straight line.
            maskImage:
              'linear-gradient(to right,' +
              ' rgba(0,0,0,0)    0%,' +
              ' rgba(0,0,0,0.05) 4%,' +
              ' rgba(0,0,0,0.18) 8%,' +
              ' rgba(0,0,0,0.45) 13%,' +
              ' rgba(0,0,0,0.78) 18%,' +
              ' rgba(0,0,0,1)    22%,' +
              ' rgba(0,0,0,1)    78%,' +
              ' rgba(0,0,0,0.78) 82%,' +
              ' rgba(0,0,0,0.45) 87%,' +
              ' rgba(0,0,0,0.18) 92%,' +
              ' rgba(0,0,0,0.05) 96%,' +
              ' rgba(0,0,0,0)    100%)',
            WebkitMaskImage:
              'linear-gradient(to right,' +
              ' rgba(0,0,0,0)    0%,' +
              ' rgba(0,0,0,0.05) 4%,' +
              ' rgba(0,0,0,0.18) 8%,' +
              ' rgba(0,0,0,0.45) 13%,' +
              ' rgba(0,0,0,0.78) 18%,' +
              ' rgba(0,0,0,1)    22%,' +
              ' rgba(0,0,0,1)    78%,' +
              ' rgba(0,0,0,0.78) 82%,' +
              ' rgba(0,0,0,0.45) 87%,' +
              ' rgba(0,0,0,0.18) 92%,' +
              ' rgba(0,0,0,0.05) 96%,' +
              ' rgba(0,0,0,0)    100%)',
          }}
        />
      </div>

      {/* ── Foreground starfield OVER the image (top portion only) ─────────
          z-[1] sits between image (-z-0) and content (z-10). Fastest parallax
          → most pronounced depth cue when scrolling past the hero. */}
      {renderStarLayer(overlay, STARS_OVERLAY_FACTOR, {
        zClass: 'z-[1]',
        dotSize: 'h-[2px] w-[2px]',
        shineSize: 'h-[4px] w-[4px]',
        heightClass: 'h-[100vh]',
      })}

      {/* ── Shooting stars — rare diagonal streaks across the upper sky.
          Sit at -z-[5]: in FRONT of all three starfields (-z-10) but BEHIND
          the hero image (-z-0), so a streak can never cross the building —
          it peeks through the faded sky at the image edges. The h-[55vh]
          overflow clip is a hard backstop for the "upper half only" rule
          (the lower half of the hero reads as ground). */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-[5] h-[55vh] overflow-hidden">
        {shooters.map((s) => (
          <ShootingStarEl key={s.id} s={s} />
        ))}
      </div>

      {/* Rare long streak — sweeps the whole hero width at the same -z-[5]
          depth: it vanishes behind the opaque image centre and re-emerges on
          the far side, which is exactly what a real meteor would do. Same
          upper-half clip as the edge streaks. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-[5] h-[55vh] overflow-hidden">
        {frontShooters.map((s) => (
          <ShootingStarEl key={s.id} s={s} cls="shooting-star-front" />
        ))}
      </div>

      {/* ── Existing decoration (grid + glow + rings + Mission Control) ──── */}
      <div className="hero-grid-bg pointer-events-none absolute inset-0" />

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[600px] w-[600px] rounded-full bg-indigo-600/10 blur-[120px]" />
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="animate-ring-1 absolute h-[360px] w-[360px] rounded-full border border-indigo-500/20" />
        <div className="animate-ring-2 absolute h-[520px] w-[520px] rounded-full border border-indigo-500/15" />
        <div className="animate-ring-3 absolute h-[680px] w-[680px] rounded-full border border-indigo-500/10" />
      </div>

      <div className="pointer-events-none absolute right-8 top-28 hidden opacity-30 lg:block">
        <div className="flex flex-col gap-2">
          {[
            [0.55, 0.35, 0.65, 0.40],
            [0.70, 0.50, 0.30, 0.60],
            [0.45, 0.75, 0.55, 0.35],
          ].map((row, r) => (
            <div key={r} className="flex gap-2">
              {row.map((opacity, c) => (
                <div
                  key={c}
                  className="h-8 w-12 rounded border border-indigo-500/30 bg-indigo-900/20"
                  style={{ opacity }}
                />
              ))}
            </div>
          ))}
        </div>
        <p className="mt-3 text-center text-[10px] font-mono uppercase tracking-widest text-indigo-400/60">
          Mission Control
        </p>
      </div>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="relative z-10 mx-auto max-w-4xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-300 backdrop-blur-md">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
          Sovereign Knowledge Infrastructure
        </div>

        <h1
          className="mb-6 text-5xl font-bold leading-tight tracking-tight text-white md:text-6xl lg:text-7xl"
          aria-label="Ground Your AI. Command Your Data."
        >
          <span className="text-shadow-hero">Ground Your AI.</span>
          <br />
          {/* Typewriter line — rotating sovereignty statements, typed and
              deleted like a terminal prompt. Screen readers get the static
              aria-label above instead of the churn.
              `bg-clip-text` makes the fill transparent, so a CSS `text-shadow`
              would render the shadow THROUGH the transparent letters and read
              as a shadow inside the glyphs. `filter: drop-shadow(...)` instead
              traces the shape of the rendered (gradient-filled) glyphs and
              drops the shadow behind them — which is what we want. The caret
              lives inside the gradient span (so it's gradient-tinted too) and
              is always rendered, which keeps the line from ever collapsing.

              Height reservation: on mobile the phrases wrap differently
              ("Command Your Data." wraps to 2 lines while the shorter phrases
              fit on 1), so the H1's rendered height used to change every
              rotation and everything below it jumped. Fix: stack an invisible
              copy of every phrase in the same CSS grid cell as the visible
              one (`grid-area:1/1`). Grid auto-sizes the shared row to the
              TALLEST item, so the box always reserves the worst-case (2-line)
              height up front — no JS measurement, adapts to every breakpoint
              automatically, and the visible phrase just overlays on top. */}
          <span className="relative grid">
            {TYPED_PHRASES.map((phrase) => (
              <span
                key={phrase}
                aria-hidden
                className="invisible [grid-area:1/1] bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent"
              >
                {phrase}
              </span>
            ))}
            <span
              aria-hidden
              className="[grid-area:1/1] bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent"
              style={{
                filter:
                  'drop-shadow(0 1px 2px rgba(0,0,0,0.55)) ' +
                  'drop-shadow(0 2px 8px rgba(0,0,0,0.45)) ' +
                  'drop-shadow(0 4px 18px rgba(0,0,0,0.35))',
              }}
            >
              {typed}
              <span className="animate-caret">_</span>
            </span>
          </span>
        </h1>

        {/* Crisp category line — complements the "Sovereign Knowledge
            Infrastructure" eyebrow badge above with the plain-language
            positioning term (also read by search + LLM crawlers). */}
        <p className="mb-6 text-lg font-medium text-slate-300 md:text-xl">
          The enterprise memory layer for AI.
        </p>

        {/* Glass-card backdrop gives the paragraph solid readability over the
            mission-control imagery without darkening the hero. Mirrors the
            iced-glass language used on the trust signals further down. */}
        <div className="mx-auto mb-10 max-w-2xl rounded-2xl border border-white/10 bg-slate-950/45 px-6 py-4 backdrop-blur-md">
          <p className="text-base leading-relaxed text-slate-200 md:text-lg">
            <strong className="font-semibold text-white">Running at the speed of trust.</strong>{' '}
            Your company's knowledge — every source, every team, every agent session — fused into{' '}
            <span className="text-indigo-300">one governed knowledge fabric you own</span>, on your own
            infrastructure. Agents and tools will come and go. Your knowledge infrastructure stays.{' '}
            <span className="font-semibold text-white">
              <span className="whitespace-nowrap">No vendor lock-in.</span>{' '}
              <span className="whitespace-nowrap">No token tax.</span>
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link to="/register" className="btn-cta-primary" data-umami-event="cta_register">
            Get Started Free
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
          <Link to="/login" className="btn-cta-secondary">
            Sign In
          </Link>
        </div>

        <div className="mt-10 inline-flex items-center gap-3 rounded-xl border border-slate-700/60 bg-slate-900/80 px-5 py-3 backdrop-blur-sm">
          <span className="text-slate-500 select-none">$</span>
          <code className="font-mono text-sm text-slate-200">{INSTALL_CMD}</code>
          <button
            onClick={async () => {
              // Try the modern clipboard API first; fall back to the legacy
              // document.execCommand path for non-secure-context edge cases.
              let ok = false
              try {
                await navigator.clipboard.writeText(INSTALL_CMD)
                ok = true
              } catch {
                try {
                  const ta = document.createElement('textarea')
                  ta.value = INSTALL_CMD
                  ta.style.position = 'fixed'
                  ta.style.opacity = '0'
                  document.body.appendChild(ta)
                  ta.select()
                  ok = document.execCommand('copy')
                  document.body.removeChild(ta)
                } catch {
                  ok = false
                }
              }
              if (ok) {
                setCopied(true)
                if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
                copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800)
              }
            }}
            data-umami-event="install_copy"
            aria-label={copied ? 'Copied to clipboard' : 'Copy install command'}
            title={copied ? 'Copied' : 'Copy install command'}
            className={`ml-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              copied
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'text-slate-500 hover:bg-slate-700 hover:text-slate-300'
            }`}
          >
            {copied ? (
              <>
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Copied
              </>
            ) : (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>

        <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
          {['Made in Europe', 'Fully On-Prem', 'GDPR-Ready', 'Open Source · No Lock-in'].map((tag) => (
            <span key={tag} className="glass-pill">
              <svg className="h-3.5 w-3.5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce text-slate-600">
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </section>
  )
}
