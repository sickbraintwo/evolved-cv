/**
 * filter-engine.js — PURE logic module. No DOM, no Three.js, no globals.
 * Safe to import from Node for testing (see tools/run-tests.mjs, test.html).
 *
 * Concepts:
 * - "expskill" (canonical taxonomy tag, e.g. "ai-automation"), owned by a
 *   domain. Experiences reference these EXPLICITLY via their `expskills` array
 *   (no more free-text + alias matching).
 * - "unit": filterable item. If an experience has projects[], each project is a
 *   unit; otherwise the experience itself is the unit. Units inherit their
 *   experience's expskills (experience-grain filtering).
 *
 * Filter semantics: pure OR across ALL active tags (within and across
 * domains). A unit matches if it carries ANY selected expskill.
 * Empty selection = everything matches.
 */

/* ---------------------------------------------------------- tag → domain map */

/** Map of tagId -> domainId. Also the set of VALID expskill ids. */
export function buildTagDomainMap(taxonomy) {
  const map = new Map();
  for (const domain of taxonomy.domains) {
    for (const tag of domain.tags) map.set(tag.id, domain.id);
  }
  return map;
}

/* -------------------------------------------------------------------- units */

/**
 * Build the flat list of filterable units from cv data.
 * Each unit: { id, expId, kind, name, company, period, tags:[expskill], domains }
 * Experience-grain filtering: every unit (project or experience) carries its
 * PARENT experience's explicit `expskills`, so all projects of an experience
 * match/unmatch together. Per-project units are still emitted so the projects
 * counter stays accurate.
 */
export function buildUnits(data, taxonomy = data.tag_taxonomy) {
  const tagDomain = buildTagDomainMap(taxonomy);
  const units = [];

  const domainsOf = (tags) => [...new Set(tags.map((t) => tagDomain.get(t)))];
  const expskillsOf = (exp) =>
    [...new Set(exp.expskills || [])].filter((id) => tagDomain.has(id));

  for (const exp of data.experience) {
    const tags = expskillsOf(exp);
    const domains = domainsOf(tags);
    if (Array.isArray(exp.projects) && exp.projects.length > 0) {
      exp.projects.forEach((project, i) => {
        units.push({
          id: `${exp.id}::${i}`,
          expId: exp.id,
          kind: "project",
          name: project.name,
          company: exp.company,
          period: exp.period,
          tags,
          domains
        });
      });
    } else {
      units.push({
        id: exp.id,
        expId: exp.id,
        kind: "experience",
        name: exp.role?.en || exp.id,
        company: exp.company,
        period: exp.period,
        tags,
        domains
      });
    }
  }
  return units;
}

/* ------------------------------------------------------------------ filtering */

/**
 * Filter units by active L1 tags.
 * Pure OR: a unit matches if it carries ANY active tag (regardless of which
 * domain each tag belongs to). Empty set = all units.
 * `data` may be the full cv data object or a prebuilt units array.
 */
export function filterUnits(data, activeTags, taxonomy) {
  const units = Array.isArray(data) ? data : buildUnits(data, taxonomy || data.tag_taxonomy);
  const active = [...activeTags];
  if (active.length === 0) return units;

  return units.filter((unit) => active.some((t) => unit.tags.includes(t)));
}

/** Number of matching units (projects/experiences). */
export function countProjects(units) {
  return units.length;
}

/* ------------------------------------------------------------------ duration */

/** "YYYY-MM" -> absolute month index. */
function monthIndex(ym) {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

/**
 * Total experience duration across units, merging overlapping intervals so
 * concurrent roles are not double-counted. `end` null/"present" = today.
 * Returns { years, months, totalMonths }.
 */
export function totalDuration(units, now = new Date()) {
  // Dedupe periods by experience (project units share the parent period)
  const seen = new Set();
  const intervals = [];
  const nowIdx = now.getFullYear() * 12 + now.getMonth();

  for (const unit of units) {
    if (seen.has(unit.expId)) continue;
    seen.add(unit.expId);
    const { start, end } = unit.period;
    if (!start) continue;
    const s = monthIndex(start);
    const e = !end || end === "present" ? nowIdx : monthIndex(end);
    intervals.push([s, Math.max(s, e)]);
  }

  intervals.sort((a, b) => a[0] - b[0]);
  let totalMonths = 0;
  let cur = null;
  for (const [s, e] of intervals) {
    if (cur && s <= cur[1] + 1) {
      cur[1] = Math.max(cur[1], e); // merge overlapping or contiguous
    } else {
      if (cur) totalMonths += cur[1] - cur[0] + 1;
      cur = [s, e];
    }
  }
  if (cur) totalMonths += cur[1] - cur[0] + 1;

  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12, totalMonths };
}

/* ------------------------------------------------------------------ headline */

/**
 * Compute the hero headline for the active tag selection.
 * 1. Exact (order-insensitive) match against curated headline_rules.
 * 2. Compositive fallback: up to 3 headline_fragments (taxonomy order)
 *    + role_fallback of the prevalent domain.
 * 3. Empty selection: profile headline (caller passes it via `fallback`).
 */
export function computeHeadline(activeTags, rules, taxonomy, lang = "en", fallback = "") {
  const active = [...activeTags];
  if (active.length === 0) return fallback;

  const key = [...active].sort().join("|");
  for (const rule of rules || []) {
    if ([...rule.match].sort().join("|") === key) {
      return rule.headline[lang] || rule.headline.en;
    }
  }

  // Compositive fallback — walk taxonomy in order for stable output
  const fragments = [];
  const domainCount = new Map();
  let prevalent = null;
  for (const domain of taxonomy.domains) {
    for (const tag of domain.tags) {
      if (!active.includes(tag.id)) continue;
      if (fragments.length < 3) {
        fragments.push(tag.headline_fragment[lang] || tag.headline_fragment.en);
      }
      const n = (domainCount.get(domain.id) || 0) + 1;
      domainCount.set(domain.id, n);
      if (!prevalent || n > domainCount.get(prevalent)) prevalent = domain.id;
    }
  }
  if (fragments.length === 0) return fallback;

  const domain = taxonomy.domains.find((d) => d.id === prevalent);
  const role = domain ? domain.role_fallback[lang] || domain.role_fallback.en : "";
  return `${fragments.join(" · ")} ${role}`.trim();
}
