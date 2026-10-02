import { createRequire } from "node:module";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DEFAULT_PET_ANIMATIONS, FRAME_AT_SOURCE, frameAt, parsePetPackage } from "./compat.js";
import { imageDimensionsFromData } from "image-dimensions";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { lstat, readFile } from "node:fs/promises";
import { release } from "node:os";
import { runNativeCommand } from "@deepseek-ai/dsh-native-command";
//#region lib/types/activity.js
/** Host activity projection adapter consumed by the pet domain. */
/**
* Owns detached host activity records and publishes whole replacements. When
* constructed with a Context, it supplies the existing session lifecycle as
* the default host producer; a richer host projection can instead be
* provided to PetService through the `petActivity` service key.
*/
var PetActivityProjection = class {
	records = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	/**
	* @param ctx - optional host context for the default session producer.
	*/
	constructor(ctx) {
		if (ctx === void 0) return;
		ctx.on("session/event", (session, event) => {
			this.observe(session, event);
		}, { global: true });
		ctx.on("session/disposed", (session) => {
			this.forget(session);
		}, { global: true });
	}
	/** Read a detached activity projection. */
	getSnapshot() {
		return [...this.records.values()].map((record) => ({ ...record }));
	}
	/** Subscribe to whole detached projection replacements. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Publish one host-owned replacement after its producer commits.
	* @param records - detached records replacing the current projection.
	*/
	publish(records) {
		this.records.clear();
		for (const record of records) this.records.set(String(record.sessionId), { ...record });
		this.notify();
	}
	observe(session, event) {
		if (event.type !== "turn/start" && event.type !== "turn/end") return;
		const record = event.type === "turn/start" ? {
			sessionId: session.id,
			title: String(session.id),
			status: "running",
			since: event.time,
			completed: false
		} : {
			sessionId: session.id,
			title: String(session.id),
			status: event.data.reason.kind === "blocked" || event.data.reason.kind === "error" ? "blocked" : "idle",
			since: event.time,
			completed: event.data.reason.kind !== "blocked" && event.data.reason.kind !== "error"
		};
		this.records.set(String(session.id), record);
		this.notify();
	}
	forget(session) {
		if (this.records.delete(String(session.id))) this.notify();
	}
	notify() {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
};
//#endregion
//#region lib/types/http-api.js
/** Same-origin JSON transport for the browser pet controls. */
const PET_API_SNAPSHOT_PATH = "/__dsh/pet/api/snapshot";
const PET_API_ACTION_PATH = "/__dsh/pet/api/action";
const PET_API_BODY_LIMIT_BYTES = 4096;
var BodyLimitError = class extends Error {};
/** Serve one request after the owning WebServer routes it to the pet API. */
async function handlePetHttpRequest(service, req, res) {
	const pathname = new URL(req.url ?? "/", "http://dsh.local").pathname;
	if (pathname === "/__dsh/pet/api/snapshot") {
		if (req.method !== "GET") return sendError(res, 405, "method-not-allowed", "Method not allowed.");
		return sendJson(res, 200, {
			ok: true,
			value: service.getSnapshot()
		});
	}
	if (pathname !== "/__dsh/pet/api/action") return sendError(res, 404, "not-found", "Pet API route not found.");
	if (req.method !== "POST") return sendError(res, 405, "method-not-allowed", "Method not allowed.");
	if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return sendError(res, 415, "unsupported-media-type", "Expected application/json.");
	let action;
	try {
		action = parseAction(JSON.parse(await readBoundedBody$1(req, PET_API_BODY_LIMIT_BYTES)));
	} catch (error) {
		if (error instanceof BodyLimitError) return sendError(res, 413, "body-too-large", "Pet API request body is too large.");
		return sendError(res, 400, "invalid-request", "Pet API request is invalid.");
	}
	try {
		sendJson(res, 200, {
			ok: true,
			value: await dispatchAction(service, action)
		});
	} catch {
		sendError(res, 400, "pet-operation-failed", "Pet operation failed.");
	}
}
function parseAction(value) {
	if (!isRecord$1(value) || typeof value.operation !== "string") throw new TypeError("action must be an object");
	switch (value.operation) {
		case "set-awake":
			requireKeys(value, ["operation", "awake"]);
			if (typeof value.awake !== "boolean") throw new TypeError("awake must be boolean");
			return {
				operation: value.operation,
				awake: value.awake
			};
		case "select-pet":
		case "update-pet-package":
			requireKeys(value, ["operation", "petId"]);
			if (typeof value.petId !== "string" || value.petId.length === 0 || value.petId.length > 64) throw new TypeError("petId is invalid");
			return {
				operation: value.operation,
				petId: value.petId
			};
		case "set-size":
			requireKeys(value, ["operation", "sizePx"]);
			if (!Number.isSafeInteger(value.sizePx)) throw new TypeError("sizePx is invalid");
			return {
				operation: value.operation,
				sizePx: value.sizePx
			};
		case "refresh-catalog":
		case "import-pet-package":
		case "open-pet-folder":
			requireKeys(value, ["operation"]);
			return { operation: value.operation };
		default: throw new TypeError("operation is unsupported");
	}
}
function dispatchAction(service, action) {
	switch (action.operation) {
		case "set-awake": return service.setAwake(action.awake);
		case "select-pet": return service.selectPet(action.petId);
		case "set-size": return service.setSize(action.sizePx);
		case "refresh-catalog": return service.refreshCatalog();
		case "import-pet-package": return service.importPetPackage();
		case "update-pet-package": return service.updatePetPackage(action.petId);
		case "open-pet-folder": return service.openPetFolder();
	}
}
function requireKeys(value, expected) {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new TypeError("action fields are invalid");
}
function sendError(res, status, code, message) {
	sendJson(res, status, {
		ok: false,
		error: {
			code,
			message
		}
	});
}
function sendJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}
function readBoundedBody$1(req, limitBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		let overLimit = false;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limitBytes) overLimit = true;
			else chunks.push(chunk);
		});
		req.on("end", () => {
			if (overLimit) reject(new BodyLimitError());
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
//#endregion
//#region lib/types/runtime.js
/** Browser-safe pet constants, validation, presentation selection, and timing. */
/** Version of the durable pet preference document. */
const PET_PREFERENCE_VERSION = 3;
/** Built-in identifier selected by a fresh preference document. */
const DEFAULT_PET_ID = "bea-brawl-stars";
/** Default logical CSS height of one compatible atlas cell. */
const DEFAULT_PET_SIZE_PX = 192;
/** Minimum logical CSS height accepted by the pet preference validator. */
const MIN_PET_SIZE_PX = 80;
/** Maximum logical CSS height accepted by the pet preference validator. */
const MAX_PET_SIZE_PX = 224;
/** Compatible atlas geometry owned by the DSH renderer. */
const PET_COMPAT_ATLAS = Object.freeze({
	width: 1536,
	height: 1872,
	cellWidth: 192,
	cellHeight: 208,
	columns: 8,
	rows: 9
});
/** Stable validation error that callers can diagnose without parsing messages. */
var PetValidationError = class extends TypeError {
	/** Machine-readable validation category. */
	code = "invalid-pet-package";
	constructor(message) {
		super(message);
		this.name = "PetValidationError";
	}
};
/** Numeric status precedence, where lower values are selected first. */
const ACTIVITY_PRIORITY = {
	"needs-input": 0,
	blocked: 1,
	ready: 2,
	running: 3
};
/**
* Sort activity records by user-action urgency, then newest state transition,
* then their stable opaque session ids.
* @param left - the first activity record.
* @param right - the second activity record.
* @returns a standard ascending sort comparison result.
*/
function comparePetActivities(left, right) {
	const priority = ACTIVITY_PRIORITY[left.status] - ACTIVITY_PRIORITY[right.status];
	if (priority !== 0) return priority;
	if (left.since !== right.since) return right.since - left.since;
	return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}
/** Resolve a missing preference or validate a current preference document.
* @param value - decoded preference value from the settings provider.
* @returns the validated v3 preference.
*/
function resolvePetPreference(value) {
	if (value === void 0 || value === null) return defaultPetPreference();
	if (!isRecord(value) || typeof value.version !== "number") throw new TypeError("pet preference must be an object with a numeric version");
	if (value.version !== 3) throw new TypeError(`pet preference version ${String(value.version)} is unsupported (expected 3)`);
	return {
		version: 3,
		selectedPetId: requirePetId(value.selectedPetId),
		awake: requireBoolean(value.awake, "awake"),
		sizePx: validatePetSize(value.sizePx)
	};
}
/** Return the fresh v3 preference defaults.
* @returns a new v3 preference document.
*/
function defaultPetPreference() {
	return {
		version: 3,
		selectedPetId: DEFAULT_PET_ID,
		awake: true,
		sizePx: 192
	};
}
/** Validate one logical CSS height.
* @param sizePx - candidate logical CSS height.
* @returns the validated height.
*/
function validatePetSize(sizePx) {
	if (typeof sizePx !== "number" || !Number.isSafeInteger(sizePx) || sizePx < 80 || sizePx > 224) throw new TypeError(`pet preference sizePx must be between 80 and 224`);
	return sizePx;
}
/** Return true only after pointer movement exceeds the shared four-pixel drag threshold.
* @param deltaX - horizontal pointer displacement.
* @param deltaY - vertical pointer displacement.
* @param threshold - minimum Euclidean displacement.
* @returns whether the displacement is a drag.
*/
function isDragMovement(deltaX, deltaY, threshold = 4) {
	return Number.isFinite(deltaX) && Number.isFinite(deltaY) && Number.isFinite(threshold) && threshold >= 0 && Math.hypot(deltaX, deltaY) > threshold;
}
/** Derive the logical CSS width from one validated atlas-cell height.
* @param sizePx - validated logical CSS height.
* @returns the corresponding logical CSS width.
*/
function petWidthForSize(sizePx) {
	return Math.round(validatePetSize(sizePx) * PET_COMPAT_ATLAS.cellWidth / PET_COMPAT_ATLAS.cellHeight);
}
/** Pick one of sixteen clockwise look-direction cells from a relative target.
* @param target - relative pointer target, or `undefined` for neutral direction.
* @returns a direction index from zero through fifteen.
*/
function selectLookDirection(target) {
	if (target === void 0 || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return 0;
	if (Math.abs(target.x) <= 1 && Math.abs(target.y) <= 1) return 0;
	const angle = Math.atan2(target.x, -target.y);
	const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
	return Math.floor((normalized + Math.PI / 16) / (Math.PI / 8)) % 16;
}
/** Select the state and first frame used to render one presentation update.
* @param input - current host, pointer, motion, and wake state.
* @returns the renderer-independent presentation selection.
*/
function selectPetPresentation(input) {
	const lookDirection = selectLookDirection(input.lookTarget);
	if (!input.awake) return {
		state: "tucked",
		row: 0,
		frame: 0,
		lookDirection,
		lookDirectionActive: false,
		animate: false
	};
	let state = statusToAnimationState(input.status);
	if (input.hover) state = "jumping";
	else if (input.status === "running" && input.dragDirection === "left") state = "running-left";
	else if (input.status === "running" && input.dragDirection === "right") state = "running-right";
	const spriteIndex = DEFAULT_PET_ANIMATIONS[state]?.frames[0]?.spriteIndex ?? 0;
	return {
		state,
		row: Math.floor(spriteIndex / PET_COMPAT_ATLAS.columns),
		frame: spriteIndex % PET_COMPAT_ATLAS.columns,
		lookDirection,
		lookDirectionActive: false,
		animate: !input.reducedMotion
	};
}
/** Validate a compatible manifest and its WebP dimensions without Node or filesystem APIs.
* @param manifestBytes - UTF-8 pet.json bytes.
* @param spritesheetBytes - WebP atlas bytes.
* @param options - catalog origin, optional asset URL, and byte limits.
* @returns a sanitized descriptor suitable for client transport.
*/
function validatePetPackage(manifestBytes, spritesheetBytes, options) {
	return validatePetPackageFiles(manifestBytes, spritesheetBytes, options).descriptor;
}
/** Validate package bytes and retain the manifest-relative asset location for host storage.
* @param manifestBytes - UTF-8 pet.json bytes.
* @param spritesheetBytes - WebP atlas bytes.
* @param options - catalog origin, optional asset URL, and byte limits.
* @returns sanitized client metadata and the validated relative spritesheet path.
*/
function validatePetPackageFiles(manifestBytes, spritesheetBytes, options) {
	const maxManifestBytes = options.maxManifestBytes ?? 16384;
	const maxSpriteBytes = options.maxSpriteBytes ?? 16777216;
	if (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes <= 0) throw new PetValidationError("manifest byte limit is invalid");
	if (!Number.isSafeInteger(maxSpriteBytes) || maxSpriteBytes <= 0) throw new PetValidationError("spritesheet byte limit is invalid");
	if (manifestBytes.byteLength > maxManifestBytes) throw new PetValidationError("pet manifest exceeds the configured byte limit");
	if (spritesheetBytes.byteLength === 0 || spritesheetBytes.byteLength > maxSpriteBytes) throw new PetValidationError("pet spritesheet exceeds the configured byte limit");
	parseManifest(manifestBytes, {
		width: PET_COMPAT_ATLAS.width,
		height: PET_COMPAT_ATLAS.height
	});
	const pet = parseManifest(manifestBytes, webpDimensions(spritesheetBytes));
	const assetUrl = options.assetUrl ?? "";
	if (assetUrl !== "" && !isOriginRelativePathname(assetUrl)) throw new PetValidationError("pet assetUrl must be an origin-relative pathname");
	const descriptor = Object.freeze({
		id: pet.id,
		source: options.source,
		displayName: pet.displayName,
		...pet.description === "" ? {} : { description: pet.description },
		frame: pet.frame,
		animations: pet.animations,
		assetUrl
	});
	return Object.freeze({
		descriptor,
		spritesheetPath: pet.spritesheetPath
	});
}
/** Resolve the safe relative spritesheet location before reading the image file.
* @param manifestBytes - bounded UTF-8 pet.json bytes.
* @returns the manifest-relative spritesheet path.
*/
function petSpritesheetPath(manifestBytes) {
	return parseManifest(manifestBytes, {
		width: PET_COMPAT_ATLAS.width,
		height: PET_COMPAT_ATLAS.height
	}).spritesheetPath;
}
/** Convert a host activity record into the pet's display status.
* @param record - detached host activity record.
* @returns the display status, or `undefined` when the record is idle.
*/
function petStatusForHostActivity(record) {
	if (record.pendingInteraction !== void 0) return "needs-input";
	if (record.status === "blocked") return "blocked";
	if (record.completed) return "ready";
	if (record.status === "running") return "running";
}
function statusToAnimationState(status) {
	switch (status) {
		case "needs-input": return "waiting";
		case "blocked": return "failed";
		case "ready": return "review";
		case "running": return "running";
		default: return "idle";
	}
}
function requirePetId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 64) throw new TypeError("pet preference selectedPetId must be a non-empty string");
	return value;
}
function requireBoolean(value, name) {
	if (typeof value !== "boolean") throw new TypeError(`pet preference ${name} must be boolean`);
	return value;
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function webpDimensions(bytes) {
	assertCompleteWebp(bytes);
	const dimensions = imageDimensionsFromData(bytes);
	if (dimensions?.type !== "webp") throw new PetValidationError("pet spritesheet must be a valid WebP image");
	return {
		width: dimensions.width,
		height: dimensions.height
	};
}
function assertCompleteWebp(bytes) {
	if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") throw new PetValidationError("pet spritesheet must be a valid WebP image");
	if (readUint32(bytes, 4) + 8 !== bytes.length) throw new PetValidationError("pet spritesheet must be a valid WebP image");
	let offset = 12;
	let hasImagePayload = false;
	while (offset + 8 <= bytes.length) {
		const chunk = ascii(bytes, offset, 4);
		const size = readUint32(bytes, offset + 4);
		const data = offset + 8;
		if (data + size > bytes.length) throw new PetValidationError("pet spritesheet must be a valid WebP image");
		if (chunk === "VP8 " && size >= 10 && (readByte(bytes, data) & 1) === 0 && bytes[data + 3] === 157 && bytes[data + 4] === 1 && bytes[data + 5] === 42) hasImagePayload = true;
		if (chunk === "VP8L" && size >= 5 && bytes[data] === 47) hasImagePayload = true;
		offset = data + size + size % 2;
	}
	if (offset !== bytes.length || !hasImagePayload) throw new PetValidationError("pet spritesheet must be a valid WebP image");
}
function parseManifest(manifestBytes, dimensions) {
	let value;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
	} catch {
		throw new PetValidationError("pet manifest must be valid UTF-8 JSON");
	}
	if (!isRecord(value) || Array.isArray(value)) throw new PetValidationError("pet manifest must be a JSON object");
	const allowed = /* @__PURE__ */ new Set([
		"id",
		"displayName",
		"description",
		"spritesheetPath",
		"frame",
		"animations",
		"kind",
		"spriteVersionNumber"
	]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new PetValidationError(`pet manifest contains unsupported field ${key}`);
	const id = value.id;
	if (typeof id !== "string" || !/^[\p{L}][\p{L}\p{N}._-]{0,63}$/u.test(id)) throw new PetValidationError("pet manifest id is invalid");
	const displayName = value.displayName;
	if (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 80) throw new PetValidationError("pet manifest displayName is invalid");
	const description = value.description;
	if (description !== void 0 && (typeof description !== "string" || description.length > 500)) throw new PetValidationError("pet manifest description is invalid");
	const parsed = parsePetPackage({
		...value,
		spritesheetDimensions: dimensions
	});
	if (!parsed.accepted) throw new PetValidationError(`pet package is incompatible: ${parsed.reason}`);
	return parsed.pet;
}
function ascii(bytes, offset, length) {
	return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function readUint32(bytes, offset) {
	return readByte(bytes, offset) + (readByte(bytes, offset + 1) << 8) + (readByte(bytes, offset + 2) << 16) + readByte(bytes, offset + 3) * 16777216;
}
function readByte(bytes, offset) {
	const value = bytes[offset];
	if (value === void 0) throw new PetValidationError("pet spritesheet has a truncated chunk");
	return value;
}
function isOriginRelativePathname(value) {
	if (!value.startsWith("/") || value.startsWith("//")) return false;
	const parsed = new URL(value, "http://dsh.local");
	return parsed.origin === "http://dsh.local" && parsed.pathname === value && parsed.search === "" && parsed.hash === "";
}
//#endregion
//#region lib/types/host-image.js
/** Host-only complete WebP decoding for package publication. */
const SHARP_ENTRY_URL = pathToFileURL(createRequire(import.meta.url).resolve("sharp")).href;
const DECODE_SCRIPT = `
import fs from 'node:fs';
import sharp from ${JSON.stringify(SHARP_ENTRY_URL)};
const input = fs.readFileSync(0);
try {
  const result = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  process.stdout.write(JSON.stringify({ width: result.info.width, height: result.info.height }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
/** Decode every pixel in a bounded WebP inside an isolated process.
* @param bytes - already byte-limited candidate WebP data.
* @param timeoutMs - positive host-configured decode deadline.
* @returns dimensions reported by the successful decoder.
*/
function decodeWebpDimensions(bytes, timeoutMs) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new PetValidationError("pet spritesheet decode timeout must be positive");
	const result = spawnSync(process.execPath, [
		"--input-type=module",
		"--eval",
		DECODE_SCRIPT
	], {
		input: bytes,
		encoding: "utf8",
		env: scrubbedParentEnv(),
		maxBuffer: 65536,
		timeout: timeoutMs,
		windowsHide: true
	});
	if (result.status !== 0) throw new PetValidationError("pet spritesheet must be a decodable WebP image");
	try {
		const dimensions = JSON.parse(result.stdout);
		if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)) throw new Error("invalid decoder result");
		return {
			width: dimensions.width,
			height: dimensions.height
		};
	} catch {
		throw new PetValidationError("pet spritesheet decoder returned invalid dimensions");
	}
}
//#endregion
//#region lib/types/catalog.js
/** Host-side compatible pet catalog and transactional user-package storage. */
/** One validated built-in or user package with detached client metadata. */
var PetCatalogStore = class {
	/** Absolute DSH-owned directory for user-installed pet packages. */
	petRoot;
	options;
	records = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	/**
	* Load the embedded package and the configured DSH user root.
	* @param options - package root and validation limits.
	*/
	constructor(options = {}) {
		this.options = { ...options };
		this.petRoot = resolve(options.petRoot ?? join(resolveDshHome(options.dshHome), "pets"));
		this.reload();
	}
	/** Read a detached deterministic catalog.
	* @returns a stable descriptor list without filesystem references.
	*/
	getCatalog() {
		return Object.freeze({ pets: Object.freeze([...this.records.values()].map((record) => ({ ...record.descriptor }))) });
	}
	/** Return a detached validated sprite for one catalog-owned id.
	* @param id - catalog id to resolve.
	* @returns a copied sprite byte array, or `undefined` for an unknown id.
	*/
	getAsset(id) {
		const record = this.records.get(id);
		return record === void 0 ? void 0 : new Uint8Array(record.spriteBytes);
	}
	/** Subscribe to catalog publication and return its disposer.
	* @param listener - callback receiving each detached catalog.
	* @returns a disposer that removes the listener.
	*/
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Check that an id names a loaded package.
	* @param id - catalog id to test.
	* @returns whether the id is currently loaded.
	*/
	has(id) {
		return this.records.has(id);
	}
	/** Create the configured user root before a host action opens it. */
	ensureRoot() {
		mkdirSync(this.petRoot, { recursive: true });
	}
	/**
	* Atomically publish one validated package under the user root.
	* @param manifestBytes - UTF-8 compatible pet.json bytes.
	* @param spritesheetBytes - validated WebP bytes.
	* @returns the newly published descriptor.
	*/
	importPackage(manifestBytes, spritesheetBytes) {
		const firstPass = validatePetPackageFiles(manifestBytes, spritesheetBytes, {
			...this.options,
			assetUrl: "",
			source: "user"
		});
		decodeWebpDimensions(spritesheetBytes, this.options.decodeTimeoutMs ?? 1e4);
		if (firstPass.descriptor.id === DEFAULT_PET_ID) throw new Error(`pet id ${DEFAULT_PET_ID} is reserved for the built-in package`);
		if (this.records.has(firstPass.descriptor.id)) throw new Error(`pet id ${firstPass.descriptor.id} is already registered`);
		mkdirSync(this.petRoot, { recursive: true });
		const target = join(this.petRoot, firstPass.descriptor.id);
		if (existsSync(target)) throw new Error(`pet package directory ${firstPass.descriptor.id} already exists`);
		const temporary = join(this.petRoot, `.${firstPass.descriptor.id}.${randomUUID()}.tmp`);
		try {
			mkdirSync(temporary);
			writeFileSync(join(temporary, "pet.json"), manifestBytes, { flag: "wx" });
			const spriteTarget = join(temporary, firstPass.spritesheetPath.replaceAll("\\", "/"));
			mkdirSync(dirname(spriteTarget), { recursive: true });
			writeFileSync(spriteTarget, spritesheetBytes, { flag: "wx" });
			renameSync(temporary, target);
		} catch (error) {
			rmSync(temporary, {
				recursive: true,
				force: true
			});
			throw error;
		}
		this.reload();
		const published = this.records.get(firstPass.descriptor.id)?.descriptor;
		if (published === void 0) throw new Error(`pet package ${firstPass.descriptor.id} was not published after atomic rename`);
		return { ...published };
	}
	/**
	* Atomically replace one existing user package's content in place.
	* @param manifestBytes - UTF-8 compatible pet.json bytes whose id names a loaded user package.
	* @param spritesheetBytes - validated WebP bytes.
	* @returns the freshly published descriptor.
	*/
	replacePackage(manifestBytes, spritesheetBytes) {
		const firstPass = validatePetPackageFiles(manifestBytes, spritesheetBytes, {
			...this.options,
			assetUrl: "",
			source: "user"
		});
		decodeWebpDimensions(spritesheetBytes, this.options.decodeTimeoutMs ?? 1e4);
		const id = firstPass.descriptor.id;
		if (this.records.get(id)?.source !== "user") throw new TypeError(`pet package ${id} is not an updatable user package`);
		mkdirSync(this.petRoot, { recursive: true });
		this.sweepTemporaryDirectories(id);
		const target = join(this.petRoot, id);
		const staged = join(this.petRoot, `.${id}.${randomUUID()}.tmp`);
		const aside = join(this.petRoot, `.${id}.${randomUUID()}.tmp`);
		try {
			mkdirSync(staged);
			writeFileSync(join(staged, "pet.json"), manifestBytes, { flag: "wx" });
			const spriteTarget = join(staged, firstPass.spritesheetPath.replaceAll("\\", "/"));
			mkdirSync(dirname(spriteTarget), { recursive: true });
			writeFileSync(spriteTarget, spritesheetBytes, { flag: "wx" });
			renameSync(target, aside);
			try {
				renameSync(staged, target);
			} catch (error) {
				renameSync(aside, target);
				throw error;
			}
		} catch (error) {
			rmSync(staged, {
				recursive: true,
				force: true
			});
			throw error;
		}
		rmSync(aside, {
			recursive: true,
			force: true
		});
		this.reload();
		const published = this.records.get(id)?.descriptor;
		if (published === void 0) throw new Error(`pet package ${id} was not published after replacement`);
		return { ...published };
	}
	/** Dispose all update listeners owned by the catalog service. */
	dispose() {
		this.listeners.clear();
		this.records.clear();
	}
	/** Delete the `.tmp` residue of earlier interrupted imports or replacements of one id. */
	sweepTemporaryDirectories(id) {
		for (const entry of readdirSync(this.petRoot, { withFileTypes: true })) if (entry.name.startsWith(`.${id}.`) && entry.name.endsWith(".tmp")) rmSync(join(this.petRoot, entry.name), {
			recursive: true,
			force: true
		});
	}
	/** Reload validated package records from the embedded assets and the user root, then publish one detached catalog. */
	reload() {
		const next = /* @__PURE__ */ new Map();
		const builtin = readValidatedPackage(new URL("../assets/bea/pet.json", import.meta.url), this.options, "builtin");
		next.set(DEFAULT_PET_ID, builtin);
		if (existsSync(this.petRoot) && isDirectory(this.petRoot)) for (const entry of readdirSync(this.petRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
			const directory = join(this.petRoot, entry.name);
			if (entry.name === "deepseek-whale") continue;
			try {
				const record = readValidatedPackage(join(directory, "pet.json"), this.options, "user");
				if (next.has(record.descriptor.id)) throw new Error(`pet id ${record.descriptor.id} is duplicated`);
				next.set(record.descriptor.id, record);
			} catch {}
		}
		this.records.clear();
		for (const id of [DEFAULT_PET_ID, ...[...next.keys()].filter((key) => key !== DEFAULT_PET_ID).sort()]) {
			const record = next.get(id);
			if (record !== void 0) this.records.set(id, record);
		}
		const catalog = this.getCatalog();
		for (const listener of this.listeners) listener(catalog);
	}
};
function readValidatedPackage(manifest, options, source) {
	const maxManifestBytes = options.maxManifestBytes ?? 16384;
	const maxSpriteBytes = options.maxSpriteBytes ?? 16777216;
	const manifestBytes = readRegularFile(manifest, "pet manifest", maxManifestBytes);
	const relativeSprite = petSpritesheetPath(manifestBytes);
	const spriteLocation = manifest instanceof URL ? new URL(relativeSprite.replaceAll("\\", "/"), manifest) : join(dirname(manifest), relativeSprite.replaceAll("\\", "/"));
	if (typeof manifest === "string" && typeof spriteLocation === "string") assertContainedFile(dirname(manifest), spriteLocation);
	const spriteBytes = readRegularFile(spriteLocation, "pet spritesheet", maxSpriteBytes);
	const validated = validatePetPackageFiles(manifestBytes, spriteBytes, {
		...options,
		assetUrl: "",
		source
	});
	if (source === "user") decodeWebpDimensions(spriteBytes, options.decodeTimeoutMs ?? 1e4);
	const id = validated.descriptor.id;
	const descriptor = Object.freeze({
		...validated.descriptor,
		assetUrl: `/__dsh/pet/assets/${id}/spritesheet.webp`
	});
	if (descriptor.id !== id) throw new Error(`pet package id ${descriptor.id} does not match its catalog key ${id}`);
	return {
		descriptor,
		spriteBytes,
		source
	};
}
function readRegularFile(path, label, maxBytes) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`${label} byte limit is invalid`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
	if (stat.size > maxBytes) throw new Error(`${label} exceeds the configured byte limit`);
	const handle = openSync(path, "r");
	try {
		const openedStat = fstatSync(handle);
		if (!openedStat.isFile() || openedStat.size > maxBytes) throw new Error(`${label} exceeds the configured byte limit`);
		const bytes = new Uint8Array(openedStat.size + 1);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const count = readSync(handle, bytes, offset, bytes.byteLength - offset, null);
			if (count === 0) break;
			offset += count;
		}
		if (offset !== openedStat.size) throw new Error(`${label} changed while it was being read`);
		return bytes.subarray(0, offset);
	} finally {
		closeSync(handle);
	}
}
function assertContainedFile(packageRoot, candidate) {
	const canonicalRoot = realpathSync(packageRoot);
	const canonicalCandidate = realpathSync(candidate);
	const fromRoot = relative(canonicalRoot, canonicalCandidate);
	if (fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || fromRoot === ".." || isAbsolute(fromRoot)) throw new Error("pet spritesheet must stay inside its package directory");
}
function isDirectory(path) {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}
//#endregion
//#region lib/types/path-opener.js
/**
* Cross-platform native path and text-document openers used by the local GUI
* carrier.
*
* The default intent prefers the default browser for documents it renders when
* the platform can name one, then falls back to the default application. WSL
* translates every path for the Windows desktop instead of assuming a Linux
* GUI. The text-editor intent never consults the browser.
*/
/** Documents a browser renders, as opposed to ones an editor merely edits. */
const BROWSER_DOCUMENTS = /* @__PURE__ */ new Set([
	".html",
	".htm",
	".xhtml",
	".svg"
]);
/**
* The macOS bundle registered for `https` — the default browser, as
* LaunchServices records it. The nested version dict is stripped first
* because it carries its own `LSHandlerRoleAll`.
*/
function macBundleForHttps(plist) {
	const stripped = plist.replace(/LSHandlerPreferredVersions\s*=\s*\{[^}]*\};/g, "");
	const block = /\{[^{}]*LSHandlerURLScheme\s*=\s*"?https"?;[^{}]*\}/.exec(stripped)?.[0];
	if (block === void 0) return void 0;
	return /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/.exec(block)?.[1];
}
/**
* Open one browser-renderable document with the default browser.
* @returns true when a browser took it; false when this platform cannot name
* one, or naming it failed — the caller then uses the default application.
*/
async function openInBrowser(path, signal, platform, run, env) {
	if (platform === "darwin") {
		let bundle;
		try {
			const { stdout } = await run("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure"], signal);
			bundle = macBundleForHttps(stdout);
		} catch {
			return false;
		}
		if (bundle === void 0) return false;
		await run("open", [
			"-b",
			bundle,
			path
		], signal);
		return true;
	}
	if (platform === "linux") {
		const browser = env.BROWSER;
		if (browser === void 0 || browser === "") return false;
		await run(browser, [path], signal);
		return true;
	}
	return false;
}
/** PowerShell single-quoted literal (doubles embedded quotes). */
function powershellLiteral(path) {
	return `'${path.replace(/'/g, "''")}'`;
}
/** Whether one environment marker is set to a non-empty value. */
function present(value) {
	return value !== void 0 && value !== "";
}
/** Distinguish WSL from desktop Linux using its process and kernel markers. */
function isWsl(internals) {
	const env = internals.env ?? process.env;
	if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true;
	return (internals.osRelease ?? release()).toLowerCase().includes("microsoft");
}
/** Open one Windows-resolvable path through its registered desktop application. */
async function openWindowsPath(path, signal, run) {
	await run("powershell.exe", [
		"-NoProfile",
		"-Command",
		`Invoke-Item -LiteralPath ${powershellLiteral(path)}`
	], signal);
}
/** Translate a WSL path before handing it to the Windows desktop. */
async function openWslPath(path, signal, run) {
	const translated = await run("wslpath", ["-w", path], signal);
	signal.throwIfAborted();
	const windowsPath = translated.stdout.replace(/[\r\n]+$/, "");
	if (windowsPath === "") throw new Error("wslpath returned no Windows path");
	await openWindowsPath(windowsPath, signal, run);
}
/** Dispatch one shell-free platform command for the requested open intent. */
async function openNativePathWithIntent(path, signal, intent, internals = {}) {
	const platform = internals.platform ?? process.platform;
	const run = internals.run ?? runNativeCommand;
	const env = internals.env ?? process.env;
	const wsl = platform === "linux" && isWsl(internals);
	if (!wsl && intent === "default" && BROWSER_DOCUMENTS.has(extname(path).toLowerCase()) && await openInBrowser(path, signal, platform, run, env)) return;
	if (platform === "darwin") {
		await run("open", intent === "text-editor" ? ["-t", path] : [path], signal);
		return;
	}
	if (platform === "win32") {
		await openWindowsPath(path, signal, run);
		return;
	}
	if (platform === "linux") {
		if (wsl) {
			await openWslPath(path, signal, run);
			return;
		}
		await run("xdg-open", [path], signal);
		return;
	}
	throw new Error(`native path opener is unsupported on ${platform}`);
}
/**
* Open a filesystem path with the operating system's default application, or
* with the default browser when the path names a document a browser renders.
* @param path - absolute or host-resolvable path (caller owns resolution).
* @param signal - caller/connection lifetime; abort terminates the native command.
* @param internals - Platform, environment, and runner hooks for deterministic tests.
*/
function openNativePath(path, signal, internals = {}) {
	return openNativePathWithIntent(path, signal, "default", internals);
}
//#endregion
//#region lib/types/host-native.js
/** Host-native pet package and folder operations assembled from existing host seams. */
/** Assemble pet actions only when the composed directory picker is native.
* @param capability - composed directory picker capability.
* @param internals - optional filesystem and host-open test seams.
* @returns native pet actions, or `undefined` for browser-only pickers.
*/
function createPetNativeActions(capability, internals = {}) {
	if (capability?.kind !== "native") return void 0;
	const read = internals.readFile ?? (async (path) => new Uint8Array(await readFile(path)));
	return {
		async pickPetPackage() {
			const selected = await capability.pick(new AbortController().signal);
			if (selected === null) return null;
			const directory = await packageDirectory(selected);
			const manifestBytes = await read(join(directory, "pet.json"));
			const spritesheetPath = petSpritesheetPath(manifestBytes);
			return {
				manifestBytes,
				spritesheetBytes: await read(join(directory, spritesheetPath.replaceAll("\\", "/")))
			};
		},
		openPetFolder: internals.openPath ?? ((path) => openNativePath(path, new AbortController().signal))
	};
}
/** Resolve a picker result to one package directory and reject links or unrelated files. */
async function packageDirectory(selected) {
	const target = resolve(selected);
	const targetStat = await lstat(target);
	if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) return target;
	if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("pet package selection must be a directory or package file");
	const name = basename(target);
	if (name !== "pet.json" && name !== "spritesheet.webp") throw new Error("pet package selection must name pet.json or spritesheet.webp");
	const directory = dirname(target);
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("pet package directory is invalid");
	return directory;
}
//#endregion
//#region lib/types/renderer.js
/** Browser-safe sprite frame projection shared by Web and desktop documents. */
/** Resolve one elapsed presentation into a frame and CSS background projection.
* @param assetUrl - validated origin-relative sprite URL.
* @param sizePx - validated logical CSS cell height.
* @param presentation - renderer state selected for this update.
* @param elapsedMs - elapsed time since the selected state began.
* @param animations - validated package animation tracks, when available.
* @returns the selected atlas cell and its CSS background projection.
*/
function petSpriteFrame(assetUrl, sizePx, presentation, elapsedMs, animations) {
	const frame = presentation.state === "tucked" ? {
		state: "idle",
		row: 0,
		column: 0,
		done: true
	} : (() => {
		const selection = frameAt(animations ?? DEFAULT_PET_ANIMATIONS, presentation.state, elapsedMs, !presentation.animate);
		const spriteIndex = selection?.spriteIndex ?? 0;
		return {
			state: presentation.state,
			row: Math.floor(spriteIndex / PET_COMPAT_ATLAS.columns),
			column: spriteIndex % PET_COMPAT_ATLAS.columns,
			done: selection?.animation === "idle" && presentation.state !== "idle"
		};
	})();
	const width = petWidthForSize(sizePx);
	return {
		frame,
		style: {
			width,
			height: sizePx,
			backgroundImage: `url(${assetUrl})`,
			backgroundPosition: `${-frame.column * width}px ${-frame.row * sizePx}px`,
			backgroundSize: `${petWidthForSize(sizePx) * PET_COMPAT_ATLAS.columns}px ${sizePx * PET_COMPAT_ATLAS.rows}px`
		}
	};
}
/** Resolve the static first atlas cell into a CSS background projection at any display height.
* Unlike {@link petSpriteFrame} this projection is decoupled from the validated overlay size range,
* so fixed-size list avatars can render smaller than the wake-state minimum.
* @param assetUrl - validated origin-relative sprite URL.
* @param heightPx - display cell height in CSS pixels, chosen by the caller.
* @returns the frame-zero cell and its CSS background projection.
*/
function petSpriteAvatar(assetUrl, heightPx) {
	const width = Math.round(heightPx * PET_COMPAT_ATLAS.cellWidth / PET_COMPAT_ATLAS.cellHeight);
	return {
		width,
		height: heightPx,
		backgroundImage: `url(${assetUrl})`,
		backgroundPosition: "0px 0px",
		backgroundSize: `${width * PET_COMPAT_ATLAS.columns}px ${heightPx * PET_COMPAT_ATLAS.rows}px`
	};
}
//#endregion
//#region lib/types/index.js
/**
* Global desktop-pet domain: durable user preferences and a live,
* session-event-derived activity read model for companion clients.
* @module @luv1211/dsh-pet
*/
/** Schema of the durable `pet` settings namespace. */
const petPreferenceSchema = z.transform(z.object({
	version: z.number().default(3),
	selectedPetId: z.string().default(DEFAULT_PET_ID),
	awake: z.boolean().default(true),
	sizePx: z.number().default(192)
}), (value) => resolvePetPreference(value), true).default({});
/** Reject a preference that cannot select a package or preserve its document meaning. */
function validatePetPreference(value) {
	if (value.selectedPetId.length === 0) throw new TypeError("pet preference selectedPetId must not be empty");
	validatePetSize(value.sizePx);
}
/** Durable pet preferences for Harness versions without namespace registration. */
function createBeaPreferenceScope(dshHome) {
  const path = join(resolveDshHome(dshHome), "bea-pet", "preferences.json");
  let value = defaultPetPreference();
  if (existsSync(path)) value = resolvePetPreference(JSON.parse(readFileSync(path, "utf8")));
  validatePetPreference(value);
  const listeners = new Set();
  return {
    get: () => ({ ...value }),
    watch(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async replace(next) {
      validatePetPreference(next);
      mkdirSync(dirname(path), { recursive: true });
      const temp = path + "." + randomUUID() + ".tmp";
      try { writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 }); renameSync(temp, path); }
      finally { if (existsSync(temp)) rmSync(temp); }
      value = { ...next }; for (const listener of listeners) listener({ ...value });
    }
  };
}

/** Pet service (`ctx.pets`): one durable preference writer and activity aggregator. */
var PetService = class extends Service {
	static inject = ["settings", "webServer"];
	static Config = z.object({
		dshHome: z.string(),
		petRoot: z.string(),
		maxManifestBytes: z.natural().default(16384),
		maxSpriteBytes: z.natural().default(16777216),
		decodeTimeoutMs: z.natural().min(1).default(1e4)
	});
	scope;
	preference;
	catalogStore;
	catalog;
	activities = /* @__PURE__ */ new Map();
	tail = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "pets");
		this.catalogStore = new PetCatalogStore(config);
		this.catalog = this.catalogStore.getCatalog();
		this.scope = typeof ctx.settings.register === "function"
      ? ctx.settings.register("pet", petPreferenceSchema, { validate: validatePetPreference })
      : createBeaPreferenceScope(config.dshHome);
		this.preference = this.scope.get();
		if (!this.catalogStore.has(this.preference.selectedPetId)) throw new TypeError(`pet ${this.preference.selectedPetId} was not found in the pet catalog`);
		ctx.effect(() => this.scope.watch((next) => {
			this.preference = next;
			this.publish();
		}), "dsh-pet: preference watch");
		ctx.effect(() => this.catalogStore.subscribe((catalog) => {
			this.catalog = catalog;
			this.publish();
		}), "dsh-pet: catalog watch");
		const activitySource = ctx.get("petActivity") ?? new PetActivityProjection(ctx);
		this.applyActivity(activitySource.getSnapshot());
		ctx.effect(() => activitySource.subscribe((records) => {
			this.applyActivity(records);
		}), "dsh-pet: activity projection");
		const desktopCompanion = ctx.get("desktopCompanion");
		const webServer = ctx.get("webServer");
		if (webServer !== void 0) for (const path of [PET_API_SNAPSHOT_PATH, PET_API_ACTION_PATH]) ctx.effect(() => webServer.register({
			kind: "exact",
			path,
			handler: (req, res) => {
				handlePetHttpRequest(this, req, res);
			}
		}), `dsh-pet: HTTP API ${path}`);
		if (desktopCompanion !== void 0 && webServer !== void 0) {
			ctx.effect(() => desktopCompanion.register({
				id: "pet",
				entryPath: "/__dsh/pet/overlay",
				width: petWidthForSize(112),
				height: 112,
				capabilities: {
					drag: true,
					pointerInteraction: true,
					resize: {
						minWidth: petWidthForSize(80),
						maxWidth: petWidthForSize(224),
						minHeight: 80,
						maxHeight: 224
					}
				}
			}), "dsh-pet: desktop companion");
			ctx.effect(() => webServer.register({
				kind: "exact",
				path: "/__dsh/pet/overlay",
				handler: (_req, res) => {
					res.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(createPetOverlayHtml());
				}
			}), "dsh-pet: companion page");
			ctx.effect(() => webServer.register({
				kind: "exact",
				path: "/__dsh/pet/overlay-state",
				handler: (_req, res) => {
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(JSON.stringify(this.getSnapshot()));
				}
			}), "dsh-pet: companion state");
			ctx.effect(() => webServer.register({
				kind: "exact",
				path: "/__dsh/pet/overlay-awake",
				handler: (req, res) => {
					this.handleOverlayAwake(req, res);
				}
			}), "dsh-pet: companion awake write");
		}
		if (webServer !== void 0) ctx.effect(() => webServer.register({
			kind: "prefix",
			path: "/__dsh/pet/assets",
			handler: (req, res) => {
				let pathname;
				try {
					pathname = decodeURIComponent(new URL(req.url ?? "/", "http://dsh.local").pathname);
				} catch {
					res.writeHead(404);
					res.end();
					return;
				}
				const match = /^\/__dsh\/pet\/assets\/([^/]+)\/spritesheet\.webp$/.exec(pathname);
				const asset = match?.[1] === void 0 ? void 0 : this.catalogStore.getAsset(match[1]);
				if (asset === void 0) {
					res.writeHead(404);
					res.end();
					return;
				}
				res.writeHead(200, {
					"content-type": "image/webp",
					"cache-control": "no-store"
				});
				res.end(Buffer.from(asset));
			}
		}), "dsh-pet: catalog assets");
		ctx.effect(() => {
			return () => {
				this.catalogStore.dispose();
			};
		}, "dsh-pet: catalog dispose");
	}
	/**
	* The host-native operations the current composition provides. Resolved
	* per access, not captured at construction: the `petNative` provider mounts
	* as a later tree row than this service, and the composed directory picker
	* can also enter the context later. An explicit `petNative` provider wins;
	* otherwise the actions derive from the composed directory picker when it
	* serves the native backend.
	* @returns the native operations, or `undefined` in browser-only compositions.
	*/
	get nativeActions() {
		return this.ctx.get("petNative") ?? createPetNativeActions(this.ctx.get("directoryPicker")?.capability());
	}
	/**
	* Read the latest durable preference and every current activity record.
	* @returns a detached, deterministically ordered snapshot.
	*/
	getSnapshot() {
		const activities = [...this.activities.values()].sort(comparePetActivities).map((activity) => ({ ...activity }));
		const selected = activities[0];
		return {
			preference: { ...this.preference },
			catalog: { pets: this.catalog.pets.map((pet) => ({ ...pet })) },
			petRoot: this.catalogStore.petRoot,
			capabilities: {
				canImport: this.nativeActions !== void 0,
				canOpenFolder: this.nativeActions !== void 0
			},
			activities,
			...selected === void 0 ? {} : { selectedActivity: { ...selected } }
		};
	}
	/**
	* Read the current validated built-in and user package descriptors.
	* @returns a detached catalog of validated package descriptors.
	*/
	getCatalog() {
		return { pets: this.catalog.pets.map((pet) => ({ ...pet })) };
	}
	/**
	* Import one validated package selected by the native host, without accepting a client path.
	* @returns the publication, cancellation, or host-availability result.
	*/
	async importPetPackage() {
		const native = this.nativeActions;
		if (native === void 0) return { outcome: "host-unavailable" };
		const selected = await native.pickPetPackage();
		if (selected === null) return { outcome: "cancelled" };
		return {
			outcome: "published",
			pet: this.catalogStore.importPackage(selected.manifestBytes, selected.spritesheetBytes)
		};
	}
	/**
	* Rescan the user package root and republish the catalog, so packages added
	* or removed on disk appear without a restart.
	* @returns the fresh snapshot after the rescan.
	*/
	refreshCatalog() {
		this.catalogStore.reload();
		return this.getSnapshot();
	}
	/**
	* Replace one existing user package's content with bytes selected by the
	* native host. The picked manifest must name the requested package, and a
	* mismatch or a non-user target fails before anything is written.
	* @param petId - user package identifier to replace.
	* @returns the replacement, cancellation, or host-availability result.
	*/
	async updatePetPackage(petId) {
		const native = this.nativeActions;
		if (native === void 0) return { outcome: "host-unavailable" };
		const selected = await native.pickPetPackage();
		if (selected === null) return { outcome: "cancelled" };
		const picked = validatePetPackage(selected.manifestBytes, selected.spritesheetBytes, { source: "user" });
		if (picked.id !== petId) throw new TypeError(`selected pet package ${picked.id} does not match update target ${petId}`);
		return {
			outcome: "published",
			pet: this.catalogStore.replacePackage(selected.manifestBytes, selected.spritesheetBytes)
		};
	}
	/**
	* Ask the native host to open the configured DSH pet directory.
	* @returns the opened or host-availability result.
	*/
	async openPetFolder() {
		const native = this.nativeActions;
		if (native === void 0) return { outcome: "host-unavailable" };
		this.catalogStore.ensureRoot();
		await native.openPetFolder(this.catalogStore.petRoot);
		return { outcome: "opened" };
	}
	/**
	* Select a built-in or previously imported pet package.
	* @param selectedPetId - non-empty package identifier.
	* @returns the committed fresh snapshot.
	*/
	async selectPet(selectedPetId) {
		if (selectedPetId.length === 0) throw new TypeError("pet preference selectedPetId must not be empty");
		if (!this.catalogStore.has(selectedPetId)) throw new TypeError(`pet ${selectedPetId} was not found in the pet catalog`);
		return this.commit((preference) => ({
			...preference,
			selectedPetId
		}));
	}
	/**
	* Persist one validated logical CSS height for the selected companion.
	* @param sizePx - logical CSS height between the configured pet limits.
	* @returns the committed fresh snapshot.
	*/
	async setSize(sizePx) {
		validatePetSize(sizePx);
		return this.commit((preference) => ({
			...preference,
			sizePx
		}));
	}
	/**
	* Wake or tuck the selected companion.
	* @param awake - whether companion clients render the selected pet awake.
	* @returns the committed fresh snapshot.
	*/
	setAwake(awake) {
		return this.commit((preference) => ({
			...preference,
			awake
		}));
	}
	/**
	* Serve the companion page's one awake write (`POST {awake: boolean}`),
	* answering with the committed snapshot so the page applies it immediately.
	* The cross-site write fence matches the API gateway: only the JSON media
	* type is accepted, which forces a CORS preflight this loopback server never
	* answers, so a "simple" cross-site POST cannot tuck the pet blind.
	* @param req - the raw request; method, media type, and body are validated here.
	* @param res - the raw response; every failure path answers a status without a body.
	*/
	async handleOverlayAwake(req, res) {
		const fail = (status) => {
			res.writeHead(status);
			res.end();
		};
		if (req.method !== "POST") {
			fail(405);
			return;
		}
		if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
			fail(415);
			return;
		}
		let payload;
		try {
			payload = JSON.parse(await readBoundedBody(req, OVERLAY_AWAKE_BODY_LIMIT_BYTES));
		} catch (error) {
			fail(error instanceof CompanionBodyLimitError ? 413 : 400);
			return;
		}
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
			fail(400);
			return;
		}
		const keys = Object.keys(payload);
		if (keys.length !== 1 || keys[0] !== "awake") {
			fail(400);
			return;
		}
		const awake = payload.awake;
		if (typeof awake !== "boolean") {
			fail(400);
			return;
		}
		let snapshot;
		try {
			snapshot = await this.setAwake(awake);
		} catch {
			fail(500);
			return;
		}
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(JSON.stringify(snapshot));
	}
	/** Replace the local adapter state from one detached host projection. */
	applyActivity(records) {
		const next = /* @__PURE__ */ new Map();
		for (const record of records) {
			const status = petStatusForHostActivity(record);
			if (status === void 0) continue;
			next.set(String(record.sessionId), {
				sessionId: record.sessionId,
				title: record.title,
				status,
				since: record.since
			});
		}
		this.activities.clear();
		for (const [sessionId, activity] of next) this.activities.set(sessionId, activity);
		this.publish();
	}
	/** Serialize one preference write and return only after durable persistence. */
	commit(mutate) {
		const run = async () => {
			const next = mutate(this.preference);
			try {
				await this.scope.replace({ ...next });
				this.preference = next;
			} catch (error) {
				this.preference = this.scope.get();
				throw error;
			}
		};
		const attempt = this.tail.then(run);
		this.tail = attempt.then(() => void 0, () => void 0);
		return attempt.then(() => this.getSnapshot());
	}
	/** Publish a detached read model after a preference commit or activity transition. */
	publish() {
		this.ctx.emit("pet/update", this.getSnapshot());
	}
};
const PET_OVERLAY_RUNTIME_CONFIG = JSON.stringify({ atlas: PET_COMPAT_ATLAS });
/** Maximum accepted companion write body in bytes; the payload is one boolean. */
const OVERLAY_AWAKE_BODY_LIMIT_BYTES = 1024;
/** Marker for a request body that drained past `OVERLAY_AWAKE_BODY_LIMIT_BYTES`. */
var CompanionBodyLimitError = class extends Error {};
/**
* Read one request body as UTF-8. Chunks past the byte cap are drained but
* discarded — bounded memory, and the client still receives the error status.
* @param req - the request whose body is draining.
* @param limitBytes - inclusive byte cap before the read turns lossy.
* @returns the full body, or rejects with `CompanionBodyLimitError` when it passed the cap.
*/
function readBoundedBody(req, limitBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		let overLimit = false;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limitBytes) overLimit = true;
			else chunks.push(chunk);
		});
		req.on("end", () => {
			if (overLimit) reject(new CompanionBodyLimitError());
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}
/** Return a static safe DOM document; live snapshot values arrive through JSON. */
function createPetOverlayHtml() {
	return `<!doctype html>
<meta name="color-scheme" content="dark">
<style>
html,body{margin:0;overflow:hidden;background:transparent;font:12px system-ui;color:white}
#pet-root{position:fixed;inset:0;pointer-events:none}
#pet-button{position:absolute;left:0;top:0;border:0;padding:0;background:transparent;cursor:grab;color:inherit;pointer-events:auto;user-select:none;-webkit-user-select:none}
#pet-button:active{cursor:grabbing}
#pet-sprite{display:block;background-repeat:no-repeat;image-rendering:pixelated;filter:drop-shadow(0 2px 3px #000)}
#pet-label{display:block;text-align:center;text-shadow:0 1px 2px #000;white-space:nowrap}
#pet-menu{position:fixed;z-index:2;border:1px solid #4a4f5a;border-radius:6px;background:#242832;box-shadow:0 4px 10px #000a;padding:3px;pointer-events:auto}
#pet-menu button{display:block;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:4px 12px;border-radius:4px;cursor:default;white-space:nowrap}
#pet-menu button:hover{background:#3b4152}
</style>
<main id="pet-root"><button id="pet-button" type="button"><span id="pet-sprite" aria-hidden="true"></span><span id="pet-label"></span></button><div id="pet-menu" role="menu" hidden><button id="pet-menu-close" type="button" role="menuitem">关闭宠物</button></div></main>
<script>
const config=${PET_OVERLAY_RUNTIME_CONFIG};
const frameAt=${FRAME_AT_SOURCE};
const button=document.getElementById('pet-button');
const sprite=document.getElementById('pet-sprite');
const label=document.getElementById('pet-label');
const menu=document.getElementById('pet-menu');
const menuClose=document.getElementById('pet-menu-close');
const api=window.dshDesktopCompanion;
let current=null;
let hover=false;
let drag=null;
let menuOpen=false;
let moved=false;
let animationName='idle';
let activityAnimationName='idle';
let frameStarted=performance.now();
const motionQuery=window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
let reducedMotion=motionQuery?.matches===true;
motionQuery?.addEventListener?.('change',event=>{reducedMotion=event.matches;frameStarted=performance.now()});
function activityState(status){
  if(status==='needs-input')return 'waiting';
  if(status==='blocked')return 'failed';
  if(status==='ready')return 'review';
  if(status==='running')return 'running';
  return 'idle';
}
function selectedPet(){
  if(current===null)return null;
  return current.catalog.pets.find(pet=>pet.id===current.preference.selectedPetId)||current.catalog.pets[0]||null;
}
function applySnapshot(next){
  const previousPet=current===null?null:selectedPet();
  const previousActivity=activityAnimationName;
  const previousSize=current?.preference.sizePx;
  const nextActivity=activityState(next.selectedActivity?.status);
  current=next;
  const pet=selectedPet();
  const awake=next.preference.awake&&pet!==null;
  if(previousActivity!==nextActivity||previousPet?.id!==pet?.id||previousPet?.assetUrl!==pet?.assetUrl||previousSize!==next.preference.sizePx){
    activityAnimationName=nextActivity;
    animationName=nextActivity;
    frameStarted=performance.now();
  }
  // Keep the Electron companion window sized to the sprite: the shell clamps
  // the request into the registered resize capability (74..207 x 80..224), and
  // the first sample (previousSize===undefined) reconciles a window restored at
  // a stale height with the current preference.
  if(previousSize!==next.preference.sizePx&&api){
    void api.resize({width:Math.round(next.preference.sizePx*config.atlas.cellWidth/config.atlas.cellHeight),height:next.preference.sizePx}).catch(()=>{});
  }
  button.hidden=!awake;
  if(!awake){
    closeMenu();
    applyPointerInteraction();
    return;
  }
  button.style.width=String(Math.round(next.preference.sizePx*config.atlas.cellWidth/config.atlas.cellHeight))+'px';
  button.style.height=String(next.preference.sizePx)+'px';
  label.textContent=next.selectedActivity?next.selectedActivity.status:'ready';
  button.setAttribute('aria-label','DeepSeek Harness pet: '+label.textContent);
}
// The companion window must not eat clicks while nothing visible can receive
// them: interactive only while the pet is awake and the pointer is over the
// pet, a menu is open, or a drag owns the pointer.
function applyPointerInteraction(){
  const interactive=current!==null&&current.preference.awake&&(hover||menuOpen||drag!==null);
  if(api)void api.setPointerInteraction({interactive}).catch(()=>{});
}
function openMenu(x,y){
  menu.hidden=false;
  menuOpen=true;
  menu.style.left=String(Math.max(0,Math.min(x,window.innerWidth-menu.offsetWidth)))+'px';
  menu.style.top=String(Math.max(0,Math.min(y,window.innerHeight-menu.offsetHeight)))+'px';
  applyPointerInteraction();
}
function closeMenu(){
  if(!menuOpen)return;
  menu.hidden=true;
  menuOpen=false;
  applyPointerInteraction();
}
async function closePet(){
  closeMenu();
  try{
    const response=await fetch('/__dsh/pet/overlay-awake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({awake:false})});
    if(response.ok)applySnapshot(await response.json());
  }catch{
    // Write failure: the menu closing is the only immediate effect; the next
    // overlay-state sync re-applies the authoritative preference.
  }
}
function renderFrame(time){
  const pet=selectedPet();
  if(current!==null&&pet!==null&&current.preference.awake){
    const name=hover?'jumping':animationName;
    const elapsed=time-frameStarted;
    const selection=frameAt(pet.animations,name,elapsed,reducedMotion,new Set());
    const spriteIndex=selection?.spriteIndex??0;
    const displayRow=Math.floor(spriteIndex/config.atlas.columns);
    const displayColumn=spriteIndex%config.atlas.columns;
    sprite.style.width=String(Math.round(current.preference.sizePx*config.atlas.cellWidth/config.atlas.cellHeight))+'px';
    sprite.style.height=String(current.preference.sizePx)+'px';
    sprite.style.backgroundImage='url('+pet.assetUrl+')';
    sprite.style.backgroundSize=String(Math.round(current.preference.sizePx*config.atlas.columns*config.atlas.cellWidth/config.atlas.cellHeight))+'px '+String(current.preference.sizePx*config.atlas.rows)+'px';
    sprite.style.backgroundPosition=String(-displayColumn*Math.round(current.preference.sizePx*config.atlas.cellWidth/config.atlas.cellHeight))+'px '+String(-displayRow*current.preference.sizePx)+'px';
  }
  requestAnimationFrame(renderFrame);
}
async function syncSnapshot(){
  if(drag!==null)return;
  try{
    const response=await fetch('/__dsh/pet/overlay-state',{cache:'no-store'});
    if(response.ok)applySnapshot(await response.json());
  }catch{}
}
button.addEventListener('pointerenter',()=>{hover=true;applyPointerInteraction()});
button.addEventListener('pointerleave',()=>{hover=false;applyPointerInteraction()});
button.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;
  event.preventDefault();
  button.setPointerCapture(event.pointerId);
  const pending={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,sequence:0};
  drag=pending;moved=false;
  if(api)void api.startDrag({pointerId:event.pointerId,screenX:event.screenX,screenY:event.screenY}).then(result=>{if(drag===pending)pending.dragId=result.dragId}).catch(()=>{if(drag===pending)drag=null});
});
button.addEventListener('pointermove',event=>{
  if(drag===null||drag.pointerId!==event.pointerId)return;
  if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>4)moved=true;
  if(api&&drag.dragId!==undefined){drag.sequence+=1;void api.moveDrag({dragId:drag.dragId,pointerId:drag.pointerId,sequence:drag.sequence,screenX:event.screenX,screenY:event.screenY}).then(result=>{if(result.accepted&&result.direction!=='neutral')animationName=result.direction==='left'?'running-left':'running-right'}).catch(()=>{})}
});
button.addEventListener('pointerup',event=>{
  const pending=drag;if(pending===null||pending.pointerId!==event.pointerId)return;
  drag=null;
  if(api&&pending.dragId!==undefined){pending.sequence+=1;void api.endDrag({dragId:pending.dragId,pointerId:pending.pointerId,sequence:pending.sequence,screenX:event.screenX,screenY:event.screenY}).catch(()=>{})}
});
button.addEventListener('pointercancel',event=>{
  const pending=drag;if(pending===null||pending.pointerId!==event.pointerId)return;
  drag=null;
  if(api&&pending.dragId!==undefined)void api.cancelDrag({dragId:pending.dragId,pointerId:pending.pointerId}).catch(()=>{});
});
button.addEventListener('click',()=>{if(moved){moved=false;return}if(api)void api.focusMain().catch(()=>{})});
button.addEventListener('contextmenu',event=>{
  event.preventDefault();
  if(drag!==null)return;
  openMenu(event.clientX,event.clientY);
});
menuClose.addEventListener('click',()=>{void closePet()});
window.addEventListener('pointerdown',event=>{if(menuOpen&&!menu.contains(event.target))closeMenu()},true);
window.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu()});
void syncSnapshot();
setInterval(()=>void syncSnapshot(),750);
requestAnimationFrame(renderFrame);
<\/script>`;
}
//#endregion
export { DEFAULT_PET_ID, DEFAULT_PET_SIZE_PX, MAX_PET_SIZE_PX, MIN_PET_SIZE_PX, PET_PREFERENCE_VERSION, PetService, PetService as default, comparePetActivities, defaultPetPreference, isDragMovement, petSpriteAvatar, petSpriteFrame, petStatusForHostActivity, petWidthForSize, resolvePetPreference, selectLookDirection, selectPetPresentation, validatePetPackage, validatePetSize };
