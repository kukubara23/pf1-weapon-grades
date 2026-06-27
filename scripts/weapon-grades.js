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
    setDebug: (v) => { DEBUG = !!v; }
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
/*  Apply attack + damage on action use         */
/* -------------------------------------------- */

/**
 * Mutate the action's damage parts and stash an attack bonus.
 * Returns true if a base damage part was successfully transformed.
 */
function applyGradeToAction(actionUse, grade) {
  const action = actionUse?.action;
  const parts = action?.damage?.parts;

  log("Action damage.parts shape:", parts);

  if (!Array.isArray(parts) || parts.length === 0) return false;

  let transformed = false;
  for (const part of parts) {
    // Support {formula, type} objects and [formula, type] tuples.
    const formula = (part && typeof part === "object" && "formula" in part)
      ? part.formula
      : Array.isArray(part) ? part[0] : null;

    const parsed = parseDamagePart(formula);
    if (!parsed) continue;

    const newFormula = buildGradedFormula(parsed, grade);
    log(`Rewriting base damage "${formula}" -> "${newFormula}"`);

    if (part && typeof part === "object" && "formula" in part) part.formula = newFormula;
    else if (Array.isArray(part)) part[0] = newFormula;

    transformed = true;
    break; // only the first base-weapon die
  }
  return transformed;
}

Hooks.on("pf1PreActionUse", (actionUse) => {
  const item = actionUse?.item;
  const grade = getItemGrade(item);
  if (!grade) return;

  log("pf1PreActionUse for", item.name, "grade:", grade.key);

  // Attack bonus (string sources are summed by the system).
  if (grade.attack !== 0) {
    actionUse.shared ??= {};
    actionUse.shared.attackBonus ??= [];
    actionUse.shared.attackBonus.push(`${grade.attack}[${grade.label}]`);
  }

  // Primary path: rewrite the base damage part in place.
  const ok = applyGradeToAction(actionUse, grade);

  // Fallback path: if the part couldn't be rewritten (cloned data,
  // different shape, etc.), push a flat damage bonus so at least the
  // numeric portion lands. This won't add extra dice, so it's a
  // degraded mode — useful as a safety net during testing.
  if (!ok) {
    const base = parseDamagePartFromItem(item);
    if (base) {
      const fb = buildGradedFormula(base, grade);
      log("Primary rewrite failed; fallback damage formula:", fb);
      actionUse.shared ??= {};
      actionUse.shared.damageBonus ??= [];
      // Push the full graded formula as an extra damage source.
      actionUse.shared.damageBonus.push(`${fb}[${grade.label}]`);
    } else {
      log("Fallback could not determine base weapon damage.");
    }
  }
});

/**
 * Best-effort read of the weapon's own base damage from the item data,
 * used only by the fallback path.
 */
function parseDamagePartFromItem(item) {
  // Common PF1 location: first damage part on the primary attack action.
  const action = item.firstAction ?? item.actions?.contents?.[0] ?? item.actions?.[0];
  const parts = action?.damage?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const f = (part && typeof part === "object" && "formula" in part)
        ? part.formula
        : Array.isArray(part) ? part[0] : null;
      const parsed = parseDamagePart(f);
      if (parsed) return parsed;
    }
  }
  return null;
}
