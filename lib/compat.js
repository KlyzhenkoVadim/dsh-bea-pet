//#region lib/types/animation.js
/** Pure frame scheduling for pet animation tracks. */
/**
* Select a sprite frame without scheduling timers or accessing a clock.
* @param animations - committed named animation tracks.
* @param animationName - preferred track name.
* @param elapsedMs - milliseconds since the current animation began.
* @param reducedMotion - whether to hold the first preferred frame.
* @returns the selected frame, or undefined when no track is available.
*/
function frameAt(animations, animationName, elapsedMs, reducedMotion) {
	function selectFrame(tracks, name, elapsed, holdFirstFrame, visited) {
		const animation = tracks[name];
		if (animation === void 0 || animation.frames.length === 0) return void 0;
		const first = animation.frames[0];
		if (first === void 0) return void 0;
		if (holdFirstFrame) return {
			animation: name,
			spriteIndex: first.spriteIndex
		};
		const safeElapsed = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
		const totalDurationMs = animation.frames.reduce((total, frame) => total + frame.durationMs, 0);
		if (animation.loopStart === null && safeElapsed >= totalDurationMs && !visited.has(name) && animation.fallback !== name) {
			const nextVisited = new Set(visited);
			nextVisited.add(name);
			const fallback = selectFrame(tracks, animation.fallback, safeElapsed, false, nextVisited);
			if (fallback !== void 0) return fallback;
		}
		const loopStart = animation.loopStart;
		let effectiveElapsed = safeElapsed;
		if (loopStart !== null && loopStart >= 0 && loopStart < animation.frames.length && safeElapsed >= totalDurationMs) {
			const prefixDurationMs = animation.frames.slice(0, loopStart).reduce((total, frame) => total + frame.durationMs, 0);
			const loopDurationMs = animation.frames.slice(loopStart).reduce((total, frame) => total + frame.durationMs, 0);
			if (loopDurationMs > 0) effectiveElapsed = prefixDurationMs + (safeElapsed - prefixDurationMs) % loopDurationMs;
		}
		let remaining = effectiveElapsed;
		for (const frame of animation.frames) {
			if (remaining < frame.durationMs) return {
				animation: name,
				spriteIndex: frame.spriteIndex,
				...animation.frames.length <= 1 ? {} : { nextFrameInMs: frame.durationMs - remaining }
			};
			remaining -= frame.durationMs;
		}
		const last = animation.frames.at(-1);
		if (last === void 0) return void 0;
		return {
			animation: name,
			spriteIndex: last.spriteIndex
		};
	}
	return selectFrame(animations, animations[animationName] === void 0 ? "idle" : animationName, elapsedMs, reducedMotion, /* @__PURE__ */ new Set());
}
/**
* Self-contained browser source for the shared frame selector.
*
* The Electron overlay is an inline document, so it cannot import an ESM
* module at runtime. Keeping this source derived from `frameAt` prevents the
* inline renderer from carrying a second animation algorithm.
*/
/** Serialize the selector without bundler-only name helpers for inline documents. */
const FRAME_AT_SOURCE = `(${frameAt.toString().replace(/\s*__name\([^;]*\);\s*/g, "")})`;
//#endregion
//#region lib/types/manifest.js
/** Browser-safe parser for the Codex-compatible pet package format. */
const DEFAULT_CELL = Object.freeze({
	width: 192,
	height: 208
});
const DEFAULT_FRAME = Object.freeze({
	width: 192,
	height: 208,
	columns: 8,
	rows: 9
});
const MAX_PET_FRAMES = 256;
const MAX_ANIMATION_FPS = 60;
const DEFAULT_ANIMATION_FPS = 8;
/**
* Parse host-normalized manifest data without reading files or decoding image bytes.
* @param candidate - JSON-compatible manifest fields plus host-decoded dimensions.
* @returns a resolved package or a stable rejection reason.
*/
function parsePetPackage(candidate) {
	if (!isRecord(candidate)) return rejected("manifest-not-object");
	const input = candidate;
	const id = parseId(input.id);
	if (id === void 0) return rejected("manifest-id-invalid");
	const displayName = parseDisplayName(input.displayName, id);
	if (displayName === void 0) return rejected("manifest-display-name-invalid");
	const spritesheetPath = parseSpritesheetPath(input.spritesheetPath, input.spritesheetPathKind);
	if (spritesheetPath === void 0) return rejected("spritesheet-path-outside-pet-directory");
	const dimensions = parseDimensions(input.spritesheetDimensions);
	if (dimensions === void 0 || dimensions.width % DEFAULT_CELL.width !== 0 || dimensions.height % DEFAULT_CELL.height !== 0) return rejected("spritesheet-dimensions-invalid");
	const columns = dimensions.width / DEFAULT_CELL.width;
	const rows = dimensions.height / DEFAULT_CELL.height;
	const explicitFrame = input.frame === void 0 ? void 0 : parseFrame(input.frame);
	if (input.frame !== void 0 && explicitFrame === void 0) return rejected("frame-geometry-not-codex-compatible");
	if (explicitFrame !== void 0) {
		if (explicitFrame.width !== DEFAULT_CELL.width || explicitFrame.height !== DEFAULT_CELL.height) return rejected("frame-geometry-not-codex-compatible");
		if (explicitFrame.columns !== columns || explicitFrame.rows !== rows) return rejected("frame-grid-does-not-cover-spritesheet");
	}
	const frame = explicitFrame ?? Object.freeze({
		width: DEFAULT_CELL.width,
		height: DEFAULT_CELL.height,
		columns,
		rows
	});
	const frameCount = frame.columns * frame.rows;
	if (frameCount > MAX_PET_FRAMES) return rejected("frame-count-exceeds-maximum");
	const animations = parseAnimations(input.animations, frameCount);
	if (!animations.accepted) return animations;
	return {
		accepted: true,
		pet: Object.freeze({
			id,
			displayName,
			description: parseDescription(input.description),
			spritesheetPath,
			frame: Object.freeze(frame),
			frameCount,
			animations: animations.value
		})
	};
}
function parseId(value) {
	if (value === void 0) return "pet";
	if (typeof value !== "string") return void 0;
	const id = value.trim();
	return id.length === 0 ? void 0 : id;
}
function parseDisplayName(value, fallback) {
	if (value === void 0) return fallback;
	if (typeof value !== "string") return void 0;
	const name = value.trim();
	return name.length === 0 ? fallback : name;
}
function parseDescription(value) {
	return typeof value === "string" ? value.trim() : "";
}
function parseSpritesheetPath(value, kind) {
	if (kind === "absolute") return void 0;
	if (value !== void 0 && typeof value !== "string") return void 0;
	const path = (value ?? "spritesheet.webp").trim();
	if (path.length === 0) return "spritesheet.webp";
	const components = path.split(/[\\/]+/);
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.includes(":") || components.includes("..")) return void 0;
	return path;
}
function parseDimensions(value) {
	if (!isRecord(value) || !isPositiveInteger(value.width) || !isPositiveInteger(value.height)) return void 0;
	return {
		width: value.width,
		height: value.height
	};
}
function parseFrame(value) {
	if (value === void 0) return { ...DEFAULT_FRAME };
	if (!isRecord(value) || !isPositiveInteger(value.width) || !isPositiveInteger(value.height) || !isPositiveInteger(value.columns) || !isPositiveInteger(value.rows)) return void 0;
	return {
		width: value.width,
		height: value.height,
		columns: value.columns,
		rows: value.rows
	};
}
function parseAnimations(value, frameCount) {
	if (value !== void 0 && !isRecord(value)) return rejected("animation-invalid");
	const animations = { ...DEFAULT_PET_ANIMATIONS };
	if (value !== void 0) for (const [name, specification] of Object.entries(value)) {
		const animation = parseAnimation(specification);
		if (animation === void 0) return rejected("animation-invalid");
		animations[name] = animation;
	}
	for (const animation of Object.values(animations)) {
		if (animation.frames.some((frame) => frame.spriteIndex >= frameCount)) return rejected("animation-frame-out-of-range");
		if (animations[animation.fallback] === void 0) return rejected("animation-fallback-missing");
	}
	return {
		accepted: true,
		value: Object.freeze(animations)
	};
}
function parseAnimation(value) {
	if (!isRecord(value) || !Array.isArray(value.frames) || value.frames.length === 0) return void 0;
	if (value.fps !== void 0 && (!isFinitePositiveNumber(value.fps) || value.fps > MAX_ANIMATION_FPS)) return void 0;
	if (value.loop !== void 0 && typeof value.loop !== "boolean") return void 0;
	if (value.fallback !== void 0 && typeof value.fallback !== "string") return void 0;
	const frames = [];
	for (const spriteIndex of value.frames) {
		if (!isNonNegativeInteger(spriteIndex)) return void 0;
		frames.push(Object.freeze({
			spriteIndex,
			durationMs: 1e3 / (value.fps ?? DEFAULT_ANIMATION_FPS)
		}));
	}
	return Object.freeze({
		frames: Object.freeze(frames),
		loopStart: value.loop ?? true ? 0 : null,
		fallback: value.fallback === void 0 || value.fallback.length === 0 ? "idle" : value.fallback
	});
}
function defaultAnimations() {
	const idle = animationFromDurations([
		[0, 1680],
		[1, 660],
		[2, 660],
		[3, 840],
		[4, 840],
		[5, 1920]
	], 0);
	return {
		idle,
		"running-right": appStateAnimation(1, 8, 120, 220, idle),
		"running-left": appStateAnimation(2, 8, 120, 220, idle),
		waving: appStateAnimation(3, 4, 140, 280, idle),
		jumping: appStateAnimation(4, 5, 140, 280, idle),
		failed: appStateAnimation(5, 8, 140, 240, idle),
		waiting: appStateAnimation(6, 6, 150, 260, idle),
		running: appStateAnimation(7, 6, 120, 220, idle),
		review: appStateAnimation(8, 6, 150, 280, idle),
		move_right: appStateAnimation(1, 8, 120, 220, idle),
		move_left: appStateAnimation(2, 8, 120, 220, idle),
		wave: appStateAnimation(3, 4, 140, 280, idle),
		bounce: appStateAnimation(4, 5, 140, 280, idle),
		sad: appStateAnimation(5, 8, 140, 240, idle)
	};
}
/**
* Codex-compatible default animation tracks used when a manifest omits a track.
* The values are normalized from the manifest vocabulary into per-frame timing
* and loop-start metadata shared by every DSH renderer.
*/
const DEFAULT_PET_ANIMATIONS = Object.freeze(defaultAnimations());
function appStateAnimation(row, count, durationMs, finalDurationMs, idle) {
	const primary = Array.from({ length: count }, (_, column) => [row * DEFAULT_FRAME.columns + column, column === count - 1 ? finalDurationMs : durationMs]);
	const repeated = [
		...primary,
		...primary,
		...primary
	];
	return animationFromDurations([...repeated, ...idle.frames.map((frame) => [frame.spriteIndex, frame.durationMs])], repeated.length);
}
function animationFromDurations(frames, loopStart) {
	return Object.freeze({
		frames: Object.freeze(frames.map(([spriteIndex, durationMs]) => Object.freeze({
			spriteIndex,
			durationMs
		}))),
		loopStart,
		fallback: "idle"
	});
}
function rejected(reason) {
	return {
		accepted: false,
		reason
	};
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPositiveInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFinitePositiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
//#endregion
//#region lib/types/notification.js
/** Codex-derived single-slot notification semantics. */
/** Source-derived notification semantics for Codex version 26.818.5229.0. */
const PET_NOTIFICATION_SPECS = Object.freeze({
	running: Object.freeze({
		animation: "running",
		label: "Running",
		fallbackBody: "Thinking",
		lifetimeMs: 18e4
	}),
	waiting: Object.freeze({
		animation: "waiting",
		label: "Needs input",
		fallbackBody: "Needs input",
		lifetimeMs: 864e5
	}),
	review: Object.freeze({
		animation: "review",
		label: "Ready",
		fallbackBody: "Ready",
		lifetimeMs: 6048e5
	}),
	failed: Object.freeze({
		animation: "failed",
		label: "Blocked",
		fallbackBody: "Blocked",
		lifetimeMs: 36e5
	})
});
/**
* Return the immutable source-derived semantics for one notification kind.
* @param kind - notification kind to resolve.
* @returns source-derived animation, labels, and lifetime.
*/
function notificationSpec(kind) {
	return PET_NOTIFICATION_SPECS[kind];
}
/**
* Create a detached notification with the recorded fallback body.
* @param kind - notification kind to commit.
* @param updatedAtMs - epoch timestamp at which the notification was committed.
* @param body - optional body that replaces the kind's fallback body.
* @returns an immutable single-slot notification value.
*/
function createNotification(kind, updatedAtMs, body) {
	if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) throw new TypeError("pet notification timestamp is invalid");
	const fallbackBody = PET_NOTIFICATION_SPECS[kind].fallbackBody;
	return Object.freeze({
		kind,
		updatedAtMs,
		body: body ?? fallbackBody
	});
}
/**
* Return the current notification or `undefined` once its source-derived lifetime has elapsed.
* @param notification - current single-slot notification, when present.
* @param nowMs - epoch timestamp used for expiry evaluation.
* @returns the visible notification or undefined after expiry.
*/
function visibleNotification(notification, nowMs) {
	if (notification === void 0) return void 0;
	if (!Number.isFinite(nowMs)) return void 0;
	return nowMs - notification.updatedAtMs >= PET_NOTIFICATION_SPECS[notification.kind].lifetimeMs ? void 0 : notification;
}
/**
* Commit a later ambient notification over the prior single-slot value.
* @param current - currently visible notification, if one exists.
* @param incoming - newly committed notification.
* @returns a detached notification that supersedes the previous value.
*/
function replaceNotification(current, incoming) {
	return Object.freeze({ ...incoming });
}
//#endregion
//#region lib/types/terminal.js
/** Browser-safe terminal graphics protocol selection. */
/**
* Select a safe terminal graphics protocol from facts supplied by a TUI host.
* @param environment - normalized terminal and multiplexer facts.
* @returns a graphics protocol or the reason image output is disabled.
*/
function detectTerminalPetProtocol(environment) {
	if (environment.multiplexer === "tmux") return {
		supported: false,
		reason: "tmux"
	};
	if (environment.multiplexer === "zellij") return {
		supported: false,
		reason: "zellij"
	};
	if (environment.kittyWindowId === true || environment.wezterm === true) return {
		supported: true,
		protocol: "kitty"
	};
	if (isIterm2(environment)) return supportsIterm2KittyGraphics(environment.version) ? {
		supported: true,
		protocol: "kitty-local-file"
	} : {
		supported: false,
		reason: "iterm2-too-old"
	};
	if (hasKittyGraphics(environment)) return {
		supported: true,
		protocol: "kitty"
	};
	if (hasSixelGraphics(environment)) return {
		supported: true,
		protocol: "sixel"
	};
	return {
		supported: false,
		reason: "terminal"
	};
}
function isIterm2(environment) {
	return normalize(environment.terminal) === "iterm2" || includes(environment.terminalProgram, "iterm");
}
function hasKittyGraphics(environment) {
	return [
		"ghostty",
		"kitty",
		"wezterm"
	].includes(normalize(environment.terminal)) || [
		"kitty",
		"ghostty",
		"wezterm"
	].some((name) => includes(environment.term, name) || includes(environment.terminalProgram, name));
}
function hasSixelGraphics(environment) {
	return normalize(environment.terminal) === "windows-terminal" || [
		"sixel",
		"mlterm",
		"foot"
	].some((name) => includes(environment.term, name));
}
function supportsIterm2KittyGraphics(version) {
	const parsed = parseDottedVersion(version);
	if (parsed === void 0) return false;
	const [major, minor, patch] = parsed;
	return major > 3 || major === 3 && (minor > 6 || minor === 6 && patch >= 0);
}
function parseDottedVersion(version) {
	if (version === void 0 || !/^\d+(?:\.\d+){0,2}$/.test(version)) return void 0;
	const [major = "0", minor = "0", patch = "0"] = version.split(".");
	return [
		Number(major),
		Number(minor),
		Number(patch)
	];
}
function normalize(value) {
	return value?.toLocaleLowerCase() ?? "";
}
function includes(value, expected) {
	return normalize(value).includes(expected);
}
//#endregion
//#region lib/types/index.js
/**
* Derive a content-and-geometry cache key without hashing filesystem data.
* @param identity - host-calculated content digest and validated grid geometry.
* @returns a deterministic frame-cache key.
*/
function cacheKeyForSprite(identity) {
	const { contentDigest, frame } = identity;
	return `sha256-${contentDigest}-${frame.width}x${frame.height}-${frame.columns}x${frame.rows}`;
}
//#endregion
export { DEFAULT_PET_ANIMATIONS, FRAME_AT_SOURCE, PET_NOTIFICATION_SPECS, cacheKeyForSprite, createNotification, detectTerminalPetProtocol, frameAt, notificationSpec, parsePetPackage, replaceNotification, visibleNotification };
