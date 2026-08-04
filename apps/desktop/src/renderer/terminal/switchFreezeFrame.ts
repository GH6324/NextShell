/**
 * Freeze frame for terminal tab switches.
 *
 * Every tab shares one xterm instance, so switching means `reset()` (blank
 * screen) followed by an *asynchronous* replay of the incoming session's
 * buffered stream through the parser. Between those two the user sees the bare
 * background — a flash that reads as a stutter even when the replay is fast.
 *
 * This pins a snapshot of the outgoing pixels over the terminal viewport so the
 * old frame stays visible until the incoming one has actually painted. It is a
 * pure cosmetic layer: it never blocks input (`pointer-events: none`) and it is
 * removed by whichever comes first — the incoming replay finishing, a newer
 * switch, the safety timeout, or teardown. A capture that cannot be validated
 * simply produces no overlay, which is exactly the old behaviour.
 */

/** How long a frozen frame may survive if nothing releases it. */
export const SWITCH_FREEZE_TIMEOUT_MS = 400;

/** Square edge of the downscaled copy the capture validation samples. */
const SAMPLE_EDGE = 32;

/**
 * Whether a sampled snapshot has anything on it.
 *
 * A WebGL canvas created without `preserveDrawingBuffer` reads back as fully
 * transparent black once its frame has been composited, and drawing *that* over
 * the terminal would freeze a blank rectangle instead of the outgoing frame.
 * Any non-zero component in the sample (colour or alpha) means real pixels came
 * through; an all-zero sample means the readback failed — or that there was
 * genuinely nothing on screen worth freezing, which wants the same answer.
 */
export const hasVisibleSamplePixel = (pixels: ArrayLike<number>): boolean => {
  for (let index = 0; index < pixels.length; index += 1) {
    const component = pixels[index];
    if (component !== undefined && component !== 0) {
      return true;
    }
  }
  return false;
};

export interface SwitchFreezeFrameOptions {
  /**
   * Reported once per instance when capture turns out to be unavailable, with a
   * short reason. Intended for a dev-only log — this is not an error.
   */
  onCaptureFailure?: (reason: string) => void;
  timeoutMs?: number;
}

export interface SwitchFreezeFrame {
  /**
   * Snapshot the terminal's current pixels and pin them over the viewport,
   * replacing any frame still frozen. Returns whether a frame is now frozen.
   */
  capture: () => boolean;
  /** Drop the frozen frame. Idempotent. */
  release: () => void;
  dispose: () => void;
}

/**
 * @param hostElement the element `terminal.open()` was called with.
 */
export const createSwitchFreezeFrame = (
  hostElement: HTMLElement,
  options: SwitchFreezeFrameOptions = {}
): SwitchFreezeFrame => {
  const timeoutMs = options.timeoutMs ?? SWITCH_FREEZE_TIMEOUT_MS;
  let snapshot: HTMLCanvasElement | null = null;
  let overlay: HTMLCanvasElement | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleContext: CanvasRenderingContext2D | null | undefined;
  /**
   * Every way a capture can fail is a property of the renderer this terminal was
   * built with (WebGL without a preserved drawing buffer, xterm's DOM renderer,
   * no 2d context), and the renderer cannot change without rebuilding the
   * terminal — and this object with it. So the first failure latches: switching
   * tabs must not keep paying for a readback that is known to come back blank.
   */
  let unsupported = false;
  let disposed = false;

  const release = (): void => {
    if (releaseTimer !== undefined) {
      clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
    overlay?.remove();
    overlay = null;
  };

  const markUnsupported = (reason: string): false => {
    if (!unsupported) {
      unsupported = true;
      snapshot = null;
      options.onCaptureFailure?.(reason);
    }
    return false;
  };

  /**
   * Validate by drawing the snapshot into a tiny scratch canvas and reading
   * that back: the downscale is one composited draw and the readback is a few
   * KB, and it samples the *whole* frame instead of hoping a fixed region
   * happens to contain text.
   */
  const isSnapshotVisible = (candidate: HTMLCanvasElement): boolean => {
    if (sampleContext === undefined) {
      const scratch = hostElement.ownerDocument.createElement("canvas");
      scratch.width = SAMPLE_EDGE;
      scratch.height = SAMPLE_EDGE;
      sampleContext = scratch.getContext("2d", { willReadFrequently: true });
    }
    if (!sampleContext) {
      return false;
    }

    sampleContext.clearRect(0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
    sampleContext.drawImage(candidate, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
    return hasVisibleSamplePixel(sampleContext.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data);
  };

  const capture = (): boolean => {
    release();
    if (disposed || unsupported) {
      return false;
    }

    // `.xterm-screen` is the only positioned box whose size matches the cell
    // grid exactly, so the overlay can sit in it at 100%/100% and let the
    // browser scale device pixels back down — no DPR arithmetic here.
    const screen = hostElement.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) {
      return markUnsupported("no .xterm-screen element to freeze");
    }

    const sources = Array.from(screen.querySelectorAll("canvas")).filter(
      (canvas) => canvas.width > 0 && canvas.height > 0
    );
    if (sources.length === 0) {
      // xterm's DOM renderer paints rows as elements; there is nothing to read
      // back, so switches keep flashing instead of freezing.
      return markUnsupported("no canvas layers (DOM renderer)");
    }

    let width = 0;
    let height = 0;
    for (const source of sources) {
      width = Math.max(width, source.width);
      height = Math.max(height, source.height);
    }

    // One canvas per terminal, resized on demand: a full-resolution snapshot is
    // multiple megabytes and a tab switch must not allocate one every time.
    if (!snapshot) {
      snapshot = hostElement.ownerDocument.createElement("canvas");
    }
    const context = snapshot.getContext("2d");
    if (!context) {
      return markUnsupported("2d context unavailable for the snapshot canvas");
    }
    if (snapshot.width === width && snapshot.height === height) {
      context.clearRect(0, 0, width, height);
    } else {
      // Assigning the size resets the bitmap, so no separate clear is needed.
      snapshot.width = width;
      snapshot.height = height;
    }

    try {
      // Layer order is DOM order (text below, cursor above), same as what the
      // compositor shows.
      for (const source of sources) {
        context.drawImage(source, 0, 0);
      }
    } catch (error) {
      return markUnsupported(`drawImage threw: ${String(error)}`);
    }

    if (!isSnapshotVisible(snapshot)) {
      return markUnsupported("snapshot read back blank");
    }

    snapshot.dataset["nextshellSwitchFreeze"] = "true";
    snapshot.style.position = "absolute";
    snapshot.style.left = "0";
    snapshot.style.top = "0";
    snapshot.style.width = "100%";
    snapshot.style.height = "100%";
    snapshot.style.pointerEvents = "none";
    // Above every layer xterm puts in the screen element (canvases, selection,
    // decorations) without competing with anything outside it.
    snapshot.style.zIndex = "10";
    screen.appendChild(snapshot);
    overlay = snapshot;

    // Last line of defence: a replay whose completion callback never arrives
    // must not be able to leave a dead frame pinned over a live terminal.
    releaseTimer = setTimeout(release, timeoutMs);
    return true;
  };

  return {
    capture,
    release,
    dispose: () => {
      disposed = true;
      release();
      snapshot = null;
      sampleContext = null;
    }
  };
};
