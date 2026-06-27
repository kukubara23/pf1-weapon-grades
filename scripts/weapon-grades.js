/**
 * PF1 Weapon Grades
 * -----------------
 * Adds a "Weapon Grade" to weapons that scales attack bonus and base
 * weapon damage. Stored as an item flag so it is non-destructive and
 * coexists with the system's own enhancement bonus.
 */

const MODULE_ID = "pf1-weapon-grades";
const FLAG_SCOPE = MODULE_ID;
const FLAG_KEY = "grade";

/**
 * Grade definitions.
 *   attack  - flat bonus to attack rolls
 *   addDice - extra dice added to the base weapon die
 *   bonus   - how the flat damage bonus is computed:
 *             "none"      -> 0
 *             "avg"       -> floor((faces+1)/2)
 *             "max"       -> faces
 *             "avgPerDie" -> avg * (new total dice count)
 *
 * Values are placeholders / current design; tweak freely.
 */
const GRADES = {
  normal:      { label: "Normal",      attack: 0, addDice: 0, bonus: "none" },
  fine:        { label: "Fine",        attack: 1, addDice: 0, bonus: "avg" },
  exceptional: { label: "Exceptional", attack: 2, addDice: 1, bonus: "avg" },
  superior:    { label: "Superior",    attack: 3, addDice: 1, bonus: "max" },
  legendary:   { label: "Legendary",   attack: 4, addDice: 2, bonus: "max" },
  artifact:    { label: "Artifact",    attack: 5, addDice: 3, bonus: "avgPerDie" }
};

/** Toggle verbose logging to inspect PF1 internals while testing. */
let DEBUG = true;
function log(...args) {
  if (DEBUG) console.log(`${MODULE_ID} |`, ...args);
}

/* -------------------------------------------- */
/*  Formula math                                */
/* -------------------------------------------- */

/**
 * Parse a simple NdM(+K) damage formula.
 * @param {string} formula
 * @returns {{count:number, faces:number, flat:number}|null}
 */
function parseDamagePart(formula) {
  if (!formula || typeof formula !== "string") return null;
  const m = formula.match(/^\s*(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?\s*$/i);
  if (!m) return null;
  return {
    count: parseInt(m[1], 10),
    faces: parseInt(m[2], 10),
    flat: m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0
  };
}

/**
 * Build the graded formula string from a parsed base die.
 * @param {{count:number, faces:number, flat:number}} base
 * @param {object} grade
 * @returns {string}
 */
function buildGradedFormula(base, grade) {
  const { count, faces, flat } = base;
  const avg = Math.floor((faces + 1) / 2);
  const max = faces;
  const newCount = count + grade.addDice;

  let added = 0;
  switch (grade.bonus) {
    case "avg":       added = avg; break;
    case "max":       added = max; break;
    case "avgPerDie": added = avg * newCount; break;
    case "none":
    default:          added = 0;
  }

  const totalFlat = flat + added;
  let formula = `${newCount}d${faces}`;
  if (totalFlat > 0) formula += `+${totalFlat}`;
  else if (totalFlat < 0) formula += `${totalFlat}`;
  return formula;
}

/** Resolve the active grade object for an item, or null if normal/none. */
function getItemGrade(item) {
  if (item?.type !== "weapon") return null;
  const key = item.getFlag(FLAG_SCOPE, FLAG_KEY) ?? "normal";
  if (key === "normal") return null;
  const grade = GRADES[key];
  return grade ? { key, ...grade } : null;
}

const ORIG_FLAG_KEY = "originalDamage";

/**
 * Find the weapon's base damage formula string from its primary action.
 * Returns the raw formula (e.g. "1d8") or null.
 */
function readBaseFormula(item) {
  const action = item.firstAction ?? item.actions?.contents?.[0] ?? item.actions?.[0];
  const parts = action?.damage?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const f = (part && typeof part === "object" && "formula" in part)
      ? part.formula
      : Array.isArray(part) ? part[0] : null;
    if (parseDamagePart(f)) return f;
  }
  return null;
}

/**
 * Return the pristine original base formula for the weapon.
 * Prefers the stored flag; if absent, captures the current base formula
 * into the flag (only safe when the weapon is at Normal grade, which is
 * enforced by the caller / capture-on-normal hook).
 */
function getOriginalFormula(item) {
  const flagged = item.getFlag(FLAG_SCOPE, ORIG_FLAG_KEY);
  if (flagged) return flagged;
  return readBaseFormula(item);
}

/**
 * Compute the delta damage instance: the graded total minus the original
 * base, expressed as a formula to be ADDED alongside the untouched base.
 *
 * graded total = buildGradedFormula(original)
 * original     = NdM(+K)
 * delta dice   = (graded.count - original.count) d M
 * delta flat   = graded.flat - original.flat
 *
 * Returns a formula string, or null if there's nothing to add.
 */
function buildDeltaFormula(originalFormula, grade) {
  const original = parseDamagePart(originalFormula);
  if (!original) return null;

  const gradedStr = buildGradedFormula(original, grade);
  const graded = parseDamagePart(gradedStr);
  if (!graded) return null;

  const deltaCount = graded.count - original.count;
  const deltaFlat = graded.flat - original.flat;

  if (deltaCount === 0 && deltaFlat === 0) return null;

  let f = "";
  if (deltaCount > 0) f += `${deltaCount}d${original.faces}`;
  if (deltaFlat !== 0) {
    if (f && deltaFlat > 0) f += `+${deltaFlat}`;
    else if (f && deltaFlat < 0) f += `${deltaFlat}`;
    else f += `${deltaFlat}`; // delta is flat-only
  }
  return f || null;
}

/* -------------------------------------------- */
/*  Init                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  log("Initializing");
  // Expose internals for console debugging / manual testing.
  game.modules.get(MODULE_ID).api = {
    GRADES,
    parseDamagePart,
    buildGradedFormula,
    buildDeltaFormula,
    setDebug: (v) => { DEBUG = !!v; },
    /** Force (re)capture of a weapon's pristine original base formula. */
    captureOriginal: async (item) => {
      const base = readBaseFormula(item);
      if (!base) return null;
      await item.setFlag(FLAG_SCOPE, ORIG_FLAG_KEY, base);
      log(`Manually captured original for ${item.name}: "${base}"`);
      return base;
    }
  };
});

/* -------------------------------------------- */
/*  Sheet injection                             */
/* -------------------------------------------- */

/**
 * Add the Grade <select> to weapon item sheets.
 * Handles both jQuery (AppV1) and HTMLElement (AppV2) signatures.
 */
function injectGradeField(app, htmlArg) {
  const item = app?.item ?? app?.object;
  if (item?.type !== "weapon") return;

  // Normalize to a root HTMLElement.
  const root = (htmlArg instanceof HTMLElement)
    ? htmlArg
    : (htmlArg?.[0] instanceof HTMLElement ? htmlArg[0] : null);
  if (!root) {
    log("Could not resolve sheet root element; skipping injection.");
    return;
  }

  // Avoid duplicate insertion on re-render.
  if (root.querySelector(`[data-${MODULE_ID}-field]`)) return;

  const current = item.getFlag(FLAG_SCOPE, FLAG_KEY) ?? "normal";
  const options = Object.entries(GRADES)
    .map(([key, g]) =>
      `<option value="${key}" ${key === current ? "selected" : ""}>${g.label}</option>`)
    .join("");

  const wrapper = document.createElement("div");
  wrapper.className = "form-group";
  wrapper.setAttribute(`data-${MODULE_ID}-field`, "");
  wrapper.innerHTML = `
    <label>Weapon Grade</label>
    <div class="form-fields">
      <select name="flags.${FLAG_SCOPE}.${FLAG_KEY}">${options}</select>
    </div>`;

  // Preferred: top of the details tab. Fall back to sheet body.
  const target =
    root.querySelector(".tab[data-tab='details']") ||
    root.querySelector(".sheet-body") ||
    root;
  target.prepend(wrapper);
  log("Injected grade field for", item.name);
}

Hooks.on("renderItemSheet", injectGradeField);
// PF1 may use a specialized sheet class; this generic hook covers most cases.
// If your weapon sheet doesn't show the field, tell me its sheet class name.

/* -------------------------------------------- */
/*  Capture pristine original on Normal          */
/* -------------------------------------------- */

/**
 * Whenever a weapon is updated to Normal grade (or has no original stored
 * yet while at Normal), record its current base formula as the pristine
 * original. This is the safe capture point because at Normal the stored
 * base has no grade contribution.
 */
Hooks.on("updateItem", async (item, changes) => {
  if (item?.type !== "weapon") return;
  if (!item.isOwner) return;

  const gradeKey = item.getFlag(FLAG_SCOPE, FLAG_KEY) ?? "normal";
  if (gradeKey !== "normal") return;

  const base = readBaseFormula(item);
  if (!base) return;

  const existing = item.getFlag(FLAG_SCOPE, ORIG_FLAG_KEY);
  if (existing === base) return;

  log(`Capturing pristine original for ${item.name}: "${base}"`);
  await item.setFlag(FLAG_SCOPE, ORIG_FLAG_KEY, base);
});

/* -------------------------------------------- */
/*  Apply attack + damage on action use          */
/* -------------------------------------------- */

Hooks.on("pf1PreActionUse", (actionUse) => {
  const item = actionUse?.item;
  const grade = getItemGrade(item);
  if (!grade) return;

  log("pf1PreActionUse for", item.name, "grade:", grade.key);

  actionUse.shared ??= {};

  // Attack bonus (string sources are summed by the system).
  if (grade.attack !== 0) {
    actionUse.shared.attackBonus ??= [];
    actionUse.shared.attackBonus.push(`${grade.attack}[${grade.label}]`);
  }

  // Damage: append a SEPARATE part for the grade's contribution.
  // Computed from the pristine original (flag), never the live formula,
  // so it cannot compound. The base part is left untouched.
  const original = getOriginalFormula(item);
  if (!original) {
    log("No pristine original formula available; skipping damage. " +
        "Set this weapon to Normal once to capture its base die.");
    return;
  }

  const delta = buildDeltaFormula(original, grade);
  if (!delta) {
    log("No damage delta for this grade.");
    return;
  }

  const action = actionUse.action;
  const parts = action?.damage?.parts;
  if (!Array.isArray(parts)) {
    log("action.damage.parts is not an array; cannot inject damage.", parts);
    return;
  }

  // Idempotency guard: the attack dialog can re-run this hook several
  // times (your console showed repeats). Tag our part and bail if present.
  const TAG = `__wg_${grade.key}`;
  const already = parts.some((p) =>
    (p && typeof p === "object" && p.__weaponGrade) ||
    (Array.isArray(p) && p[2] === TAG));
  if (already) {
    log("Delta part already present; skipping duplicate injection.");
    return;
  }

  // Mirror the shape + damage type of the existing base part.
  const basePart = parts.find((p) => {
    const f = (p && typeof p === "object" && "formula" in p) ? p.formula
            : Array.isArray(p) ? p[0] : null;
    return parseDamagePart(f);
  });

  let newPart;
  if (basePart && typeof basePart === "object" && "formula" in basePart) {
    // Object-shaped part {formula, types, ...}. Clone its type info.
    newPart = foundry.utils.deepClone(basePart);
    newPart.formula = delta;
    newPart.__weaponGrade = grade.key; // our marker
  } else if (Array.isArray(basePart)) {
    // Tuple-shaped part [formula, type]. Append a 3rd marker element.
    newPart = [delta, basePart[1] ?? "", TAG];
  } else {
    // No base part to mirror; push a minimal object part, untyped.
    newPart = { formula: delta, types: [], __weaponGrade: grade.key };
  }

  log(`Injecting delta part "${delta}" [${grade.label}] mirroring`, basePart);
  parts.push(newPart);
});
