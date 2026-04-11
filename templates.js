/**
 * @module templates
 * @description Email template library for Clara.
 *
 * Handles:
 * - Saving, retrieving, and deleting reusable email templates
 * - Variable substitution ({{name}}, {{company}}, {{date}}, etc.)
 * - Persistent storage on disk
 *
 * All functions receive a shared `ctx` context object.
 */

const fs = require("fs");
const path = require("path");

let templates = [];
let TEMPLATES_FILE = null;

function init(ctx) {
  const dataDir = fs.existsSync("/var/data") ? "/var/data" : ".";
  TEMPLATES_FILE = path.join(dataDir, "email_templates.json");
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn(`[TEMPLATES] Could not load templates: ${e.message}`);
    templates = [];
  }
  ctx.addLog(`📋 ${templates.length} email template(s) loaded`, "info");
}

function save() {
  if (!TEMPLATES_FILE) return;
  try {
    const tmp = TEMPLATES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(templates, null, 2));
    fs.renameSync(tmp, TEMPLATES_FILE);
  } catch (e) { console.error(`[TEMPLATES] Save failed: ${e.message}`); }
}

function list() {
  return templates.map(t => ({ id: t.id, name: t.name, subject: t.subject, createdAt: t.createdAt, usageCount: t.usageCount || 0 }));
}

function get(idOrName) {
  const q = (idOrName || "").toLowerCase();
  return templates.find(t => t.id === idOrName || t.name.toLowerCase().includes(q)) || null;
}

function create({ name, subject, body, variables = [] }) {
  if (!name || !body) throw new Error("Template requires name and body");
  const id = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const template = {
    id,
    name: name.slice(0, 200),
    subject: (subject || "").slice(0, 500),
    body: body.slice(0, 10000),
    variables: variables.slice(0, 20),
    createdAt: new Date().toISOString(),
    usageCount: 0,
  };
  templates.push(template);
  if (templates.length > 100) templates.shift(); // cap at 100
  save();
  return template;
}

function remove(id) {
  const idx = templates.findIndex(t => t.id === id);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  save();
  return true;
}

/**
 * Apply variable substitution to a template.
 * Replaces {{name}}, {{company}}, {{date}}, etc. with provided values.
 * Also supports profile-based auto-fill from CRM data.
 */
function render(template, vars = {}, profile = null) {
  if (!template) return null;

  // Auto-fill from profile if available
  const allVars = {
    name: profile?.name || vars.name || "",
    firstName: profile?.firstName || vars.firstName || "",
    company: profile?.company || vars.company || "",
    role: profile?.role || vars.role || "",
    date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    ...vars,
  };

  let subject = template.subject || "";
  let body = template.body || "";

  for (const [key, value] of Object.entries(allVars)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "gi");
    subject = subject.replace(pattern, value);
    body = body.replace(pattern, value);
  }

  template.usageCount = (template.usageCount || 0) + 1;
  save();

  return { subject, body };
}

module.exports = {
  init,
  list,
  get,
  create,
  remove,
  render,
  getAll: () => templates,
};
