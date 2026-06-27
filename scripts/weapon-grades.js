/**
 * PF1 Weapon Grades
 * -----------------
 * Adds a "Weapon Grade" to weapons that scales the base weapon damage and
 * grants an attack bonus. The grade is APPLIED on demand via a button:
 * clicking "Apply" overwrites the weapon's base damage formula with the
 * graded formula, computed from a stored pristine original so it can never
 * compound. "Reset" restores the pristine original and unlocks editing.
 *
 * While a grade is applied, the base damage formula field is locked.
 *
 * Grade math (B = the weapon's base dice block, e.g. "2d4"):
 *   avg(B)  = floor of the average total of the block
 *   max(B)  = maximum total of the block (count * faces)
 *
 *   Grade        Dice block   Flat bonus
 *   Normal       1 * B        0
 *   Fine         1 * B        avg(B)
 *   Exceptional  2 * B        avg(B)
 *   Superior     2 * B        max(B)
 *   Legendary    3 * B        max(B)
 *   Artifact     4 * B        avg(B) * 4
 */

const MODULE_ID = "pf1-weapon-grades";
const FLAG_SCOPE = MODULE_ID;
const FLAG_KEY = "grade";          // selected grade key
const ORIG_FLAG_KEY = "originalDamage"; // pristine base formula string
const APPLIED_FLAG_KEY = "appliedGrade"; // grade key currently applied (or absent)

/**
 * Grade definitions.
 *   attack     - flat bonus to attack rolls
 *   diceMult   - the base dice block is multiplied by this
 *   flat       - how the flat damage bonus is computed from the base block:
 *                "none"     -> 0
 *                "avg"      -> avg(block)
 *                "max"      -> max(block)
 *                "avgx4"    -> avg(block) * 4
 */
const GRADES = {
  normal:      { label: "Normal",      attack: 0, diceMult: 1, flat: "none" },
  fine:        { label: "Fine",        attack: 1, diceMult: 1, flat: "avg" },
  exceptional: { label: "Exceptional", attack: 2, diceMult: 2, flat: "avg" },
  superior:    { label: "Superior",    attack: 3, diceMult: 2, flat: "max" },
  legendary:   { label: "Legendary",   attack: 4, diceMult: 3, flat: "max" },
  artifact:    { label: "Artifact",    attack: 5, diceMult: 4, flat: "avgx4" }
};

/** Toggle verbose logging while testing. */
let DEBUG = true;
function log(...args) {
  if (DEBUG) console.log(`${MODULE_ID} |`, ...args);
}

/* -------------------------------------------- */
/*  Formula math                                */
/* -------------------------------------------- */

/**
 * Parse a base damage formula. Handles two forms:
 *   - literal dice:  "2d4", "1d8+1"
 *   - sizeRoll:      "sizeRoll(1, 6, @size)", "sizeRoll(2, 4)"
 * @returns {{count, faces, flat, form:"dice"|"sizeRoll", sizeArgs}|null}
 */
function parseDamagePart(formula) {
  if (!formula || typeof formula !== "string") return null;

  // Strip any [flavor] brackets (our grade labels) before parsing, so a
  // previously-applied formula like "sizeRoll(2, 6, @size)[Superior]+6[Superior]"
  // can still be read back as a 2d6 base. Without this, Reset/re-Apply can't
  // locate the base part.
  formula = formula.replace(/\[[^\]]*\]/g, "").trim();

  const sr = formula.match(/^\s*sizeRoll\s*\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([^)]*))?\)\s*([+-]\s*\d+)?\s*$/i);
  if (sr) {
    return {
      count: parseInt(sr[1], 10),
      faces: parseInt(sr[2], 10),
      flat: sr[4] ? parseInt(sr[4].replace(/\s+/g, ""), 10) : 0,
      form: "sizeRoll",
      sizeArgs: sr[3] != null ? sr[3].trim() : null
    };
  }

  const m = formula.match(/^\s*(\d+)\s*d\s*(\d+)\s*([+-]\s*\d+)?\s*$/i);
  if (m) {
    return {
      count: parseInt(m[1], 10),
      faces: parseInt(m[2], 10),
      flat: m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0,
      form: "dice",
      sizeArgs: null
    };
  }
  return null;
}

/** Render a dice block of `count` dice back into the base's original form. */
function renderDice(count, faces, base) {
  if (base.form === "sizeRoll") {
    const extra = base.sizeArgs ? `, ${base.sizeArgs}` : "";
    return `sizeRoll(${count}, ${faces}${extra})`;
  }
  return `${count}d${faces}`;
}

/** Average total of a dice block: count * (faces+1)/2, floored. */
function blockAvg(count, faces) {
  return Math.floor((count * (faces + 1)) / 2);
}

/** Maximum total of a dice block. */
function blockMax(count, faces) {
  return count * faces;
}

/**
 * Build the graded formula string from a base formula and grade.
 * Preserves sizeRoll form when present. Preserves any pre-existing flat
 * modifier on the base (added on top of the grade's flat).
 * @returns {string} e.g. "4d4+5", "sizeRoll(2, 6, @size)+3"
 */
function buildGradedFormula(baseFormula, grade, label = "") {
  const base = parseDamagePart(baseFormula);
  if (!base) return null;

  const newCount = base.count * grade.diceMult;
  const avg = blockAvg(base.count, base.faces);
  const max = blockMax(base.count, base.faces);

  let added = 0;
  switch (grade.flat) {
    case "avg":   added = avg; break;
    case "max":   added = max; break;
    case "avgx4": added = avg * 4; break;
    case "none":
    default:      added = 0;
  }

  const totalFlat = base.flat + added;
  const dicePart = renderDice(newCount, base.faces, base);

  // Optional inline labels, e.g. "sizeRoll(2, 4, @size)[Fine]+5[Fine]".
  // NOTE: flavor on a function term (sizeRoll) is the risky part; flavor on
  // the flat term is safe. Controlled by the `label` argument.
  const tag = label ? `[${label}]` : "";

  let formula = `${dicePart}${tag}`;
  if (totalFlat > 0) formula += `+${totalFlat}${tag}`;
  else if (totalFlat < 0) formula += `-${Math.abs(totalFlat)}${tag}`;
  return formula;
}

/* -------------------------------------------- */
/*  Item helpers                                */
/* -------------------------------------------- */

function getActionAndParts(item) {
  const action = item.defaultAction
    ?? item.firstAction
    ?? item.actions?.contents?.[0]
    ?? item.actions?.[0];
  const parts = action?.damage?.parts;
  return { action, parts: Array.isArray(parts) ? parts : null };
}

/** Index + accessor for the first parseable base damage part. */
function findBasePart(parts) {
  if (!parts) return null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const f = (p && typeof p === "object" && "formula" in p) ? p.formula
            : Array.isArray(p) ? p[0] : null;
    if (parseDamagePart(f)) return { index: i, part: p, formula: f };
  }
  return null;
}

function readBaseFormula(item) {
  const { parts } = getActionAndParts(item);
  const bp = findBasePart(parts);
  return bp ? bp.formula : null;
}

/**
 * Return a clean, canonical base formula (labels stripped, re-rendered from
 * the parsed components). Used when capturing the pristine original so a
 * stored original is never polluted with grade labels or extra flat mods.
 * NOTE: this also strips any pre-existing flat modifier on the true base,
 * which is intended — the "original" we grade from is the pure dice block.
 */
function cleanBaseFormula(item) {
  const raw = readBaseFormula(item);
  if (!raw) return null;
  const p = parseDamagePart(raw);
  if (!p) return null;
  // Re-render the pure dice block, preserving sizeRoll form, dropping flat
  // and labels. (If a weapon legitimately has a base flat like 1d8+1, that
  // flat is preserved below instead.)
  let f = renderDice(p.count, p.faces, p);
  if (p.flat > 0) f += `+${p.flat}`;
  else if (p.flat < 0) f += `${p.flat}`;
  return f;
}

/* -------------------------------------------- */
/*  Init / API                                  */
/* -------------------------------------------- */

Hooks.once("init", () => {
  log("Initializing");

  game.settings.register(MODULE_ID, "inlineLabel", {
    name: "Inline grade label in damage formula",
    hint: "Adds e.g. [Fine] into the damage formula string. If a roll ever fails to parse, turn this off.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "infoTag", {
    name: "Show grade tag in weapon Info row",
    hint: "Adds the grade (e.g. Fine) as a tag alongside Steel / Max range in the chat card Info row.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.modules.get(MODULE_ID).api = {
    GRADES,
    parseDamagePart,
    buildGradedFormula,
    setDebug: (v) => { DEBUG = !!v; },
    applyGrade,
    resetGrade
  };
});

/* -------------------------------------------- */
/*  Apply / Reset core                          */
/* -------------------------------------------- */

/**
 * Apply the currently-selected grade to the weapon by overwriting the base
 * damage formula. Idempotent: always computes from the pristine original.
 */
async function applyGrade(item) {
  if (item?.type !== "weapon") return;

  const gradeKey = item.getFlag(FLAG_SCOPE, FLAG_KEY) ?? "normal";
  const grade = GRADES[gradeKey];
  if (!grade) return;

  const { action, parts } = getActionAndParts(item);
  if (!action || !parts) {
    ui.notifications?.warn("Weapon Grades: couldn't find a damage action on this weapon.");
    return;
  }

  // Determine the pristine original. If we've already applied a grade, the
  // stored flag is authoritative. Otherwise capture the current base now.
  let original = item.getFlag(FLAG_SCOPE, ORIG_FLAG_KEY);
  const applied = item.getFlag(FLAG_SCOPE, APPLIED_FLAG_KEY);
  if (!original) {
    if (applied) {
      ui.notifications?.error("Weapon Grades: no pristine original stored but a grade is applied. Reset manually.");
      return;
    }
    original = cleanBaseFormula(item);
    if (!original) {
      ui.notifications?.warn("Weapon Grades: base damage isn't a recognized dice formula.");
      return;
    }
  }

  // Normal grade == reset.
  if (gradeKey === "normal") {
    return resetGrade(item);
  }

  const useLabel = game.settings.get(MODULE_ID, "inlineLabel");
  const graded = buildGradedFormula(original, grade, useLabel ? grade.label : "");
  if (!graded) {
    ui.notifications?.warn("Weapon Grades: couldn't build a graded formula.");
    return;
  }

  // Locate the base part and overwrite just its formula, in a clone of parts.
  const bp = findBasePart(parts);
  if (!bp) {
    ui.notifications?.warn("Weapon Grades: no base damage part to overwrite.");
    return;
  }

  const newParts = foundry.utils.deepClone(parts);
  const target = newParts[bp.index];
  if (target && typeof target === "object" && "formula" in target) {
    target.formula = graded;
  } else if (Array.isArray(target)) {
    target[0] = graded;
  }

  // Persist: store original (if first time) + applied grade, then write the
  // damage parts back to the action via the item's action update path.
  const updates = {
    [`flags.${FLAG_SCOPE}.${ORIG_FLAG_KEY}`]: original,
    [`flags.${FLAG_SCOPE}.${APPLIED_FLAG_KEY}`]: gradeKey
  };

  const showTag = game.settings.get(MODULE_ID, "infoTag");
  await updateActionDamageParts(item, action, newParts, updates, showTag ? grade.label : null);
  log(`Applied ${grade.label}: "${original}" -> "${graded}"`);
  ui.notifications?.info(`Weapon Grades: applied ${grade.label} (${graded}).`);
}

/**
 * Reset the weapon: restore the pristine original base formula and clear the
 * applied-grade flag (which unlocks the field). Leaves the originalDamage
 * flag intact so future applies still know the true base.
 */
async function resetGrade(item) {
  if (item?.type !== "weapon") return;

  const original = item.getFlag(FLAG_SCOPE, ORIG_FLAG_KEY);
  const { action, parts } = getActionAndParts(item);

  if (original && action && parts) {
    const bp = findBasePart(parts);
    if (bp) {
      const newParts = foundry.utils.deepClone(parts);
      const target = newParts[bp.index];
      if (target && typeof target === "object" && "formula" in target) {
        target.formula = original;
      } else if (Array.isArray(target)) {
        target[0] = original;
      }
      const updates = {
        [`flags.${FLAG_SCOPE}.${APPLIED_FLAG_KEY}`]: null,
        [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: "normal"
      };
      // gradeTag = null and clearTags=true removes any of our tags.
      await updateActionDamageParts(item, action, newParts, updates, null, true);
      log(`Reset to original "${original}".`);
      ui.notifications?.info(`Weapon Grades: reset to ${original}.`);
      return;
    }
  }

  // Nothing to restore; just clear applied state.
  await item.update({
    [`flags.${FLAG_SCOPE}.${APPLIED_FLAG_KEY}`]: null,
    [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: "normal"
  });
  log("Reset: cleared applied state (no original to restore).");
}

/** All possible grade labels, used to strip our tags cleanly. */
function allGradeLabels() {
  return Object.values(GRADES).map((g) => g.label);
}

/**
 * Write modified damage parts back into the action and apply flag updates
 * in a single item update. PF1 stores actions in system.actions as an array.
 *
 * @param {string|null} gradeTag  Label to add to the action's tags (or null).
 * @param {boolean} clearTags     If true, remove all our grade tags.
 */
async function updateActionDamageParts(item, action, newParts, extraUpdates = {}, gradeTag = null, clearTags = false) {
  const actionsSource = foundry.utils.deepClone(item.system?.actions ?? []);
  const idx = actionsSource.findIndex((a) => a._id === action.id || a._id === action._id);

  // Helper to compute a new tags array for an action source object.
  const computeTags = (src) => {
    const existing = Array.isArray(src.tags) ? src.tags.slice() : [];
    const labels = allGradeLabels();
    // Remove any prior grade tags first (so switching grades replaces).
    const cleaned = existing.filter((t) => !labels.includes(t));
    if (!clearTags && gradeTag) cleaned.push(gradeTag);
    return cleaned;
  };

  if (idx === -1) {
    if (typeof action.update === "function") {
      const upd = { "damage.parts": newParts };
      if (gradeTag !== null || clearTags) {
        upd.tags = computeTags(action.toObject?.() ?? action);
      }
      await action.update(upd);
      if (Object.keys(extraUpdates).length) await item.update(extraUpdates);
      return;
    }
    ui.notifications?.error("Weapon Grades: couldn't locate the action to update.");
    return;
  }

  actionsSource[idx].damage = actionsSource[idx].damage ?? {};
  actionsSource[idx].damage.parts = newParts;
  if (gradeTag !== null || clearTags) {
    actionsSource[idx].tags = computeTags(actionsSource[idx]);
  }

  await item.update({
    "system.actions": actionsSource,
    ...extraUpdates
  });
}

/* -------------------------------------------- */
/*  Sheet injection: dropdown + buttons + lock  */
/* -------------------------------------------- */

function injectGradeUI(app, htmlArg) {
  const item = app?.item ?? app?.object;
  if (item?.type !== "weapon") return;

  const root = (htmlArg instanceof HTMLElement)
    ? htmlArg
    : (htmlArg?.[0] instanceof HTMLElement ? htmlArg[0] : null);
  if (!root) {
    log("Could not resolve sheet root element; skipping injection.");
    return;
  }

  const appliedKey = item.getFlag(FLAG_SCOPE, APPLIED_FLAG_KEY) ?? null;
  const isApplied = !!appliedKey;

  // Lock the base damage formula field whenever a grade is applied.
  lockBaseDamageField(root, isApplied);

  // Avoid duplicate control insertion on re-render.
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
    <div class="form-fields" style="gap:4px; align-items:center;">
      <select name="flags.${FLAG_SCOPE}.${FLAG_KEY}" ${isApplied ? "disabled" : ""}>${options}</select>
      <button type="button" data-wg-apply title="Overwrite base damage with the graded formula">Apply</button>
      <button type="button" data-wg-reset title="Restore original base damage and unlock">Reset</button>
    </div>
    <p class="notes" data-wg-status></p>`;

  const target =
    root.querySelector(".tab[data-tab='details']") ||
    root.querySelector(".sheet-body") ||
    root;
  target.prepend(wrapper);

  // Status line.
  const status = wrapper.querySelector("[data-wg-status]");
  if (status) {
    status.textContent = isApplied
      ? `Applied: ${GRADES[appliedKey]?.label ?? appliedKey}. Base damage is locked. Use Reset to edit.`
      : `Not applied. Select a grade and click Apply.`;
  }

  // Wire buttons.
  wrapper.querySelector("[data-wg-apply]")?.addEventListener("click", async () => {
    await applyGrade(item);
    app.render(false);
  });
  wrapper.querySelector("[data-wg-reset]")?.addEventListener("click", async () => {
    await resetGrade(item);
    app.render(false);
  });

  log("Injected grade UI for", item.name, "applied:", appliedKey);
}

/**
 * Find the base damage formula input on the PF1 action/item sheet and toggle
 * its editability. PF1's damage part inputs typically carry a name containing
 * "damage.parts" and a formula field. We disable all matching formula inputs
 * while a grade is applied.
 */
function lockBaseDamageField(root, lock) {
  // Common selectors across PF1 sheet versions; we try several.
  const selectors = [
    'input[name*="damage.parts"][name*="formula"]',
    'input[name*="damage.parts"]',
    'textarea[name*="damage.parts"]',
    '.damage-part input',
    '[data-damage-part] input'
  ];
  const seen = new Set();
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      el.toggleAttribute("disabled", lock);
      el.toggleAttribute("readonly", lock);
      el.style.opacity = lock ? "0.6" : "";
      el.title = lock ? "Locked by Weapon Grade. Use Reset to edit." : (el.title || "");
    });
  }
  if (DEBUG && seen.size) log(`lockBaseDamageField: ${lock ? "locked" : "unlocked"} ${seen.size} field(s).`);
}

Hooks.on("renderItemSheet", injectGradeUI);

log("Loaded.");
