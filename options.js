const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

async function loadRules() {
  const stored = await chrome.storage.sync.get("customRules");
  return stored.customRules || [];
}

function ruleRow(rule = { domains: [""], category: "", color: "blue" }) {
  const row = document.createElement("div");
  row.className = "rule-row";

  const domainInput = document.createElement("input");
  domainInput.value = (rule.domains && rule.domains[0]) || "";
  domainInput.placeholder = "example.com";

  const categoryInput = document.createElement("input");
  categoryInput.value = rule.category || "";
  categoryInput.placeholder = "My Category";

  const colorSelect = document.createElement("select");
  for (const c of COLORS) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === rule.color) opt.selected = true;
    colorSelect.appendChild(opt);
  }

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => row.remove());

  row.append(domainInput, categoryInput, colorSelect, removeBtn);
  row._getRule = () => ({
    domains: [domainInput.value.trim()].filter(Boolean),
    category: categoryInput.value.trim(),
    color: colorSelect.value
  });
  return row;
}

async function render() {
  const rules = await loadRules();
  const list = document.getElementById("rulesList");
  list.innerHTML = "";
  if (!rules.length) {
    list.appendChild(ruleRow());
  } else {
    for (const rule of rules) list.appendChild(ruleRow(rule));
  }
}

document.getElementById("addRuleBtn").addEventListener("click", () => {
  document.getElementById("rulesList").appendChild(ruleRow());
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const rows = [...document.getElementById("rulesList").children];
  const rules = rows
    .map(r => r._getRule())
    .filter(r => r.domains.length && r.category);
  await chrome.storage.sync.set({ customRules: rules });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
});

render();
