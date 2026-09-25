const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const appEl = document.getElementById("app");
const CATEGORY_LABEL = { internal_medicine: "内科系", surgery: "外科系" };
const INSTITUTION_LABEL = { internal: "院内", external: "院外" };

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

async function checkAuth() {
  if (sessionStorage.getItem("admin_ok") === "1") {
    renderDashboard();
    return;
  }
  appEl.innerHTML = `
    <div class="card">
      <b>管理者パスワード</b>
      <div style="margin:10px 0;"><input type="password" id="pw" placeholder="パスワード" /></div>
      <button id="login-btn">ログイン</button>
      <div class="notice warn" id="pw-error" style="display:none; margin-top:10px;"></div>
    </div>`;
  document.getElementById("login-btn").onclick = async () => {
    const pw = document.getElementById("pw").value;
    const { data, error } = await sb.rpc("verify_admin_password", { input_password: pw });
    if (error || !data) {
      document.getElementById("pw-error").style.display = "block";
      document.getElementById("pw-error").textContent = "パスワードが違います。";
      return;
    }
    sessionStorage.setItem("admin_ok", "1");
    renderDashboard();
  };
}

// 地域枠・県民枠（黒潮PJ）の学生は【一般枠】を選べず、【地・県枠】は地域枠・県民枠の学生だけが選べる。【一般枠可能】は全員選べる
function quotaAllows(slot, quota) {
  const dep = (slot && slot.department_name) || "";
  if (dep.includes("【地・県枠】")) return !!quota;
  if (dep.includes("【一般枠可能】")) return true; // 一般枠可能は全員選べる
  if (dep.includes("【一般枠】")) return !quota;
  return true;
}

// ============================================================
// 詰み判定（3:3ルールを満たして6クールを揃えられる空き枠が残っているか）
// ・確定済みの人数だけで判定（今回の希望者との取り合いは考えない＝最善ケース）
// ・黒潮の行は追加枠(NEW)のクールだけ、留学は対象外、施設全体の上限も考慮
// ============================================================
function stuckComboKey(x) {
  return (x.institution_type === "internal" ? "IN" : "EX") + "_" + (x.category === "internal_medicine" ? "N" : "G");
}
function stuckIsKuroshio(s) {
  return (s.department_name || "").includes("黒潮医療人養成プロジェクト") || (s.facility_name || "").includes("黒潮医療人養成プロジェクト");
}
function stuckIsAbroad(s) {
  const n = s.facility_name || "";
  return n.startsWith("留学(") || n.startsWith("留学（");
}
// slots: 有効な枠, assignRows: 全員の確定 [{slot_id, course_number}], limitMap: {施設名: max_total}
function buildStuckAvailability(slots, assignRows, limitMap, allowFn) {
  const slotById = {};
  slots.forEach(s => { slotById[s.id] = s; });
  const used = {}, facUsed = {};
  (assignRows || []).forEach(a => {
    used[a.slot_id + "_" + a.course_number] = (used[a.slot_id + "_" + a.course_number] || 0) + 1;
    const s = slotById[a.slot_id];
    if (s) facUsed[s.facility_name + "_" + a.course_number] = (facUsed[s.facility_name + "_" + a.course_number] || 0) + 1;
  });
  const avail = {};
  for (let c = 1; c <= 6; c++) avail[c] = { IN_N: false, IN_G: false, EX_N: false, EX_G: false };
  for (const s of slots) {
    if (s.active === false || stuckIsAbroad(s)) continue;
    if (allowFn && !allowFn(s)) continue;
    const kuro = stuckIsKuroshio(s);
    for (let c = 1; c <= 6; c++) {
      const cap = s["cap_" + c] || 0;
      if (cap <= 0) continue;
      if (kuro && !(Array.isArray(s.new_courses) && s.new_courses.map(Number).includes(c))) continue;
      if ((used[s.id + "_" + c] || 0) >= cap) continue;
      const lim = limitMap[s.facility_name];
      if (lim != null && (facUsed[s.facility_name + "_" + c] || 0) >= lim) continue;
      avail[c][stuckComboKey(s)] = true;
    }
  }
  return avail;
}
// myAssigns: [{course_number, count_exempt, institution_type, category}]
function isStudentStuck(myAssigns, avail) {
  const keys = ["IN_N", "IN_G", "EX_N", "EX_G"];
  const counts = { IN_N: 0, IN_G: 0, EX_N: 0, EX_G: 0 };
  let inN = 0, exN = 0;
  const filled = new Set();
  for (const a of myAssigns) {
    filled.add(a.course_number);
    if (a.institution_type === "internal") inN++; else exN++;
    if (!a.count_exempt) counts[stuckComboKey(a)]++;
  }
  if (filled.size >= 6) return false;
  const open = [1, 2, 3, 4, 5, 6].filter(c => !filled.has(c));
  const targets = [1, 2].map(a => ({ IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a }));
  function dfs(i, inCnt, exCnt) {
    if (inCnt > 3 || exCnt > 3) return false;
    if (!targets.some(t => keys.every(k => counts[k] <= t[k]))) return false;
    if (i === open.length) return inCnt === 3 && exCnt === 3 && keys.every(k => counts[k] >= 1);
    for (const k of keys) {
      if (!avail[open[i]][k]) continue;
      counts[k]++;
      const ok = dfs(i + 1, inCnt + (k.startsWith("IN") ? 1 : 0), exCnt + (k.startsWith("EX") ? 1 : 0));
      counts[k]--;
      if (ok) return true;
    }
    return false;
  }
  return !dfs(0, inN, exN);
}

function roundLabel(r) {
  return (r && r.title) ? r.title : `第${r ? r.round_number : "?"}希望`;
}
function sortRounds(list) {
  return (list || []).slice().sort((a, b) => (a.display_order ?? a.round_number) - (b.display_order ?? b.round_number));
}

let activeTab = "students";

async function renderDashboard() {
  appEl.innerHTML = `
    <div class="admin-tabs">
      <button data-tab="students" class="${activeTab==='students'?'active':''}">学生・リンク</button>
      <button data-tab="rounds" class="${activeTab==='rounds'?'active':''}">ラウンド管理</button>
      <button data-tab="matching" class="${activeTab==='matching'?'active':''}">集計・抽選</button>
      <button data-tab="lodging" class="${activeTab==='lodging'?'active':''}">宿泊希望</button>
      <button data-tab="trade" class="${activeTab==='trade'?'active':''}">トレード</button>
      <button data-tab="stuck" class="${activeTab==='stuck'?'active':''}">詰み確認</button>
    </div>
    <div id="tab-content"><p>読み込み中...</p></div>
  `;
  document.querySelectorAll(".admin-tabs button").forEach(b => {
    b.onclick = () => { activeTab = b.dataset.tab; renderDashboard(); };
  });
  if (activeTab === "students") renderStudentsTab();
  else if (activeTab === "rounds") renderRoundsTab();
  else if (activeTab === "matching") renderMatchingTab();
  else if (activeTab === "lodging") renderLodgingTab();
  else if (activeTab === "stuck") renderStuckTab();
  else renderTradeTab();
}

// ============================================================
// 詰み確認：3:3ルールを満たせる空き枠が残っていない学生の一覧
// ============================================================
async function renderStuckTab() {
  const el = document.getElementById("tab-content");
  const { data: slots } = await sb.from("slots").select("*").eq("active", true);
  const { data: limits } = await sb.from("facility_limits").select("*");
  const { data: students } = await sb.from("students").select("id, attendance_number, name, kuroshio_quota").order("attendance_number");
  const { data: assigns } = await sb.from("assignments").select("student_id, slot_id, course_number, count_exempt");

  const lim = {};
  (limits || []).forEach(f => { lim[f.facility_name] = f.max_total; });
  const slotById = {};
  (slots || []).forEach(s => { slotById[s.id] = s; });
  // 無効化された枠に確定している人も正しく数えるため、確定先の枠情報は全件から引く
  const { data: allSlots } = await sb.from("slots").select("id, institution_type, category, facility_name, department_name");
  const anySlot = {};
  (allSlots || []).forEach(s => { anySlot[s.id] = s; });

  // 一般の学生用と、地域枠・県民枠の学生用で選べる枠が違うので、空き状況を2通り作る
  const availGeneral = buildStuckAvailability(slots || [], assigns || [], lim, s => quotaAllows(s, null));
  const availQuota = buildStuckAvailability(slots || [], assigns || [], lim, s => quotaAllows(s, "県"));
  const byStudent = {};
  (assigns || []).forEach(a => { (byStudent[a.student_id] = byStudent[a.student_id] || []).push(a); });

  const rows = [];
  for (const st of (students || [])) {
    const mine = (byStudent[st.id] || []).map(a => {
      const s = anySlot[a.slot_id] || {};
      return { course_number: a.course_number, count_exempt: a.count_exempt, institution_type: s.institution_type, category: s.category, label: (s.facility_name || "") + " " + (s.department_name || "") };
    });
    if (mine.length >= 6) continue;
    if (!isStudentStuck(mine, st.kuroshio_quota ? availQuota : availGeneral)) continue;
    const c = { IN_N: 0, IN_G: 0, EX_N: 0, EX_G: 0 };
    mine.forEach(m => { if (!m.count_exempt) c[stuckComboKey(m)]++; });
    const filledSet = new Set(mine.map(m => m.course_number));
    const openList = [1, 2, 3, 4, 5, 6].filter(x => !filledSet.has(x)).map(x => window.COURSE_LABELS[x - 1]).join(" ");
    rows.push(`<tr>
      <td>${st.attendance_number}</td>
      <td>${esc(st.name)}</td>
      <td>${c.IN_N}/${c.IN_G}/${c.EX_N}/${c.EX_G}${mine.some(m => m.count_exempt) ? "<br/><span class='small-muted'>留学枠あり</span>" : ""}</td>
      <td>${mine.length}/6</td>
      <td>${esc(openList)}</td>
    </tr>`);
  }

  el.innerHTML = `
    <div class="card">
      <b>詰み確認（${rows.length}人）</b>
      <p class="small-muted">今の確定状況と空き枠から見て、3:3ルールを満たして6クールを揃える組み合わせが1つも残っていない学生です。今回の希望者との取り合いは考えない「最善ケース」での判定なので、ここに出ていなくても抽選次第で詰む可能性はあります。黒潮の行は追加枠(NEW)のクールのみ、留学枠は対象外として計算しています。</p>
      ${rows.length === 0 ? `<p>現在、詰んでいる学生はいません。</p>` : `
      <div style="overflow-x:auto;">
        <table class="slots">
          <thead><tr><th>番号</th><th>氏名</th><th>院内内/院内外/院外内/院外外</th><th>確定</th><th>空きクール</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>`}
      <button class="small secondary" id="stuck-reload" style="margin-top:10px;">再計算</button>
    </div>
  `;
  document.getElementById("stuck-reload").onclick = renderStuckTab;
}

// ============================================================
// トレード期間の管理
// ============================================================
async function renderTradeTab() {
  const { data: settings } = await sb.from("trade_settings").select("*").eq("id", 1).maybeSingle();

  const { data: offers } = await sb
    .from("trade_offers")
    .select("*, students:student_id(attendance_number, name), slots(facility_name, department_name)")
    .order("created_at", { ascending: false });

  const statusLabel = { open: "出品中", matched: "成立", cancelled: "取り下げ" };
  const rows = (offers || []).map(o => `
    <tr>
      <td>${o.students.attendance_number} ${esc(o.students.name)}</td>
      <td>${window.COURSE_LABELS[o.course_number-1]}</td>
      <td>${esc(o.slots.facility_name)} ${esc(o.slots.department_name)}</td>
      <td>${statusLabel[o.status] || o.status}</td>
    </tr>
  `).join("");

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <b>トレード期間の設定</b>
      <p class="small-muted">全クールの確定後に、学生同士が同じクール番号の枠を交換できる機能です（trade.html）。院内3・院外3・内科3・外科3、4組み合わせのルールを崩す交換・移動は自動的にブロックされます。</p>
      <div style="margin:10px 0;">
        <label><input type="checkbox" id="trade-enabled" ${settings && settings.enabled ? "checked" : ""} /> トレードを有効にする</label>
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">開始日時（任意）</label>
        <input type="datetime-local" id="trade-start" value="${settings && settings.start_at ? toLocalInputValue(settings.start_at) : ''}" />
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">終了日時（任意）</label>
        <input type="datetime-local" id="trade-end" value="${settings && settings.end_at ? toLocalInputValue(settings.end_at) : ''}" />
      </div>
      <button id="save-trade-settings">保存</button>
      <div id="trade-save-result" class="small-muted" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <b>出品状況（新しい順）</b>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>学生</th><th>クール</th><th>枠</th><th>状態</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="small-muted">まだ出品はありません</td></tr>'}</tbody>
      </table>
    </div>
  `;

  document.getElementById("save-trade-settings").onclick = async () => {
    const enabled = document.getElementById("trade-enabled").checked;
    const startVal = document.getElementById("trade-start").value;
    const endVal = document.getElementById("trade-end").value;
    const { error } = await sb.from("trade_settings").upsert({
      id: 1,
      enabled,
      start_at: startVal ? new Date(startVal).toISOString() : null,
      end_at: endVal ? new Date(endVal).toISOString() : null,
    });
    const resultEl = document.getElementById("trade-save-result");
    resultEl.textContent = error ? "保存に失敗しました: " + error.message : "保存しました。";
    if (!error) renderTradeTab();
  };
}

// ============================================================
// 宿泊希望の管理（締切設定・回答状況の確認）
// ============================================================
async function renderLodgingTab() {
  const { data: settings } = await sb.from("lodging_settings").select("*").eq("id", 1).maybeSingle();

  const { data: assignments } = await sb
    .from("assignments")
    .select("id, student_id, slot_id, course_number, lodging_choice, students(attendance_number, name), slots(facility_name, department_name, facility_accommodation, accommodation)");

  // 希望調査で確定した枠のキー（黒潮の行でも、追加枠で一般学生が取ったものは宿泊回答の対象にする）
  const { data: confirmedPrefs } = await sb
    .from("preferences")
    .select("student_id, slot_id, course_number, paired_course_number")
    .eq("status", "confirmed");
  const confirmedKeys = new Set();
  (confirmedPrefs || []).forEach(p => {
    confirmedKeys.add(p.student_id + "_" + p.slot_id + "_" + p.course_number);
    if (p.paired_course_number) confirmedKeys.add(p.student_id + "_" + p.slot_id + "_" + p.paired_course_number);
  });

  const lodgingRows = (assignments || []).filter(a => {
    const acc = a.slots.facility_accommodation || a.slots.accommodation || "";
    const isKuroshio = a.slots.department_name.includes("黒潮医療人養成プロジェクト") || a.slots.facility_name.includes("黒潮医療人養成プロジェクト");
    const viaPreference = confirmedKeys.has(a.student_id + "_" + a.slot_id + "_" + a.course_number);
    return acc.includes("○") && (!isKuroshio || viaPreference);
  }).sort((a, b) => a.course_number - b.course_number || a.students.attendance_number - b.students.attendance_number);

  const choiceLabel = { yes: "宿泊する", no: "宿泊しない" };
  const rows = lodgingRows.map(a => `
    <tr>
      <td>${a.students.attendance_number} ${esc(a.students.name)}</td>
      <td>${window.COURSE_LABELS[a.course_number-1]}</td>
      <td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}</td>
      <td>${a.lodging_choice ? `<span class="lodging-badge-answered">${choiceLabel[a.lodging_choice]}</span>` : '<span class="lodging-badge-unanswered">未回答</span>'}</td>
    </tr>
  `).join("");

  const answeredCount = lodgingRows.filter(a => a.lodging_choice).length;

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <b>宿泊するかどうかの回答締切</b>
      <p class="small-muted">宿泊が必要な施設に確定した学生全員に、締切とともに表示されます。</p>
      <p class="small-muted">※南和歌山医療センターの院内宿舎は「1人部屋2室・4人部屋1室」の計6人まで（病院全体の受入人数の上限ではありません）。</p>
      <div style="margin:10px 0;">
        <input type="datetime-local" id="lodging-deadline" value="${settings && settings.deadline ? toLocalInputValue(settings.deadline) : ''}" />
      </div>
      <button id="save-lodging-deadline">締切を保存</button>
      <div id="lodging-save-result" class="small-muted" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <div class="flex-between">
        <b>回答状況</b>
        <span class="small-muted">回答済み ${answeredCount} / ${lodgingRows.length}</span>
      </div>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>学生</th><th>クール</th><th>実習先</th><th>回答</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="small-muted">宿泊が必要な確定枠はまだありません</td></tr>'}</tbody>
      </table>
    </div>
  `;

  document.getElementById("save-lodging-deadline").onclick = async () => {
    const val = document.getElementById("lodging-deadline").value;
    const resultEl = document.getElementById("lodging-save-result");
    const { error } = await sb.from("lodging_settings").upsert({ id: 1, deadline: val ? new Date(val).toISOString() : null });
    resultEl.textContent = error ? "保存に失敗しました: " + error.message : "保存しました。";
    if (!error) renderLodgingTab();
  };
}

function toLocalInputValue(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderStudentsTab() {
  const { data: students } = await sb.from("students").select("*").order("attendance_number");
  const baseUrl = location.origin + location.pathname.replace(/admin\.html$/, "index.html");

  let rows = students.map(s => {
    const link = `${baseUrl}?token=${s.access_token}`;
    return `<tr>
      <td>${s.attendance_number}</td>
      <td>${esc(s.name)}</td>
      <td><input type="text" readonly value="${link}" style="font-size:0.75rem;" onclick="this.select()"/></td>
      <td><button class="small secondary copy-btn" data-link="${link}">コピー</button></td>
    </tr>`;
  }).join("");

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <div class="flex-between">
        <b>学生一覧（全${students.length}名）</b>
        <button class="small" id="export-csv">CSVで一覧出力</button>
      </div>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>番号</th><th>氏名</th><th>専用URL</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.querySelectorAll(".copy-btn").forEach(b => {
    b.onclick = () => { navigator.clipboard.writeText(b.dataset.link); b.textContent = "コピー済"; setTimeout(()=>b.textContent="コピー",1200); };
  });

  document.getElementById("export-csv").onclick = () => {
    const csv = "出席番号,氏名,専用URL\n" + students.map(s => `${s.attendance_number},${s.name},${baseUrl}?token=${s.access_token}`).join("\n");
    const blob = new Blob(["\uFEFF"+csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "student_links.csv";
    a.click();
  };
}

// ============================================================
// ラウンド管理（タームを1つ指定して、全員でそのタームを決めるラウンド）
// ============================================================
function toLocalInputValueOrEmpty(iso) {
  if (!iso) return "";
  return toLocalInputValue(iso);
}

async function renderRoundsTab() {
  const { data: rounds0 } = await sb.from("rounds").select("*");
  const rounds = sortRounds(rounds0);

  let rows = (rounds || []).map(r => `
    <tr>
      <td>${esc(roundLabel(r))}${r.eligibility === "ext_surgery_2" ? `<br/><span class="small-muted">対象：院外外科2・院外3の人</span>` : ""}</td>
      <td>${r.phase}</td>
      <td class="small-muted">
        開始:${r.start_at ? new Date(r.start_at).toLocaleString("ja-JP") : "-"}<br/>
        1次締切:${r.end_at ? new Date(r.end_at).toLocaleString("ja-JP") : "-"}<br/>
        2次締切:${r.second_deadline ? new Date(r.second_deadline).toLocaleString("ja-JP") : "-"}<br/>
        ${r.third_deadline ? `3次締切:${new Date(r.third_deadline).toLocaleString("ja-JP")}<br/>` : ""}
      </td>
      <td>${r.is_current ? "★現在" : ""}</td>
      <td>
        ${!r.is_current ? `<button class="small set-current" data-id="${r.id}">現在にする</button>` : ""}
        ${r.phase === "closed" && !r.third_deadline ? `<button class="small secondary start-third" data-id="${r.id}">3次マッチングを追加</button>` : ""}
        <div style="margin-top:6px; padding:8px; background:#f4f6f8; border-radius:8px;">
          <label class="small-muted">開始</label>
          <input type="datetime-local" class="time-start-input" data-id="${r.id}" value="${toLocalInputValueOrEmpty(r.start_at)}" />
          <label class="small-muted">1次締切</label>
          <input type="datetime-local" class="time-end-input" data-id="${r.id}" value="${toLocalInputValueOrEmpty(r.end_at)}" />
          <label class="small-muted">2次締切</label>
          <input type="datetime-local" class="time-second-input" data-id="${r.id}" value="${toLocalInputValueOrEmpty(r.second_deadline)}" />
          ${("third_deadline" in r) ? `<label class="small-muted">3次締切（使う場合のみ）</label>
          <input type="datetime-local" class="time-third-input" data-id="${r.id}" value="${toLocalInputValueOrEmpty(r.third_deadline)}" />` : ""}
          <button class="small save-times" data-id="${r.id}">日程を保存</button>
        </div>
        <div style="margin-top:6px;">
          <label class="small-muted">キャンセル受付 開始</label>
          <input type="datetime-local" class="cancel-start-input" data-id="${r.id}" value="${toLocalInputValueOrEmpty(r.cancel_window_start)}" />
          <label class="small-muted">終了</label>
          <input type="datetime-local" class="cancel-end-input" data-id="${r.id}" value="${toLocalInputValueOrEmpty(r.cancel_window_end)}" />
          <button class="small save-cancel-window" data-id="${r.id}">保存</button>
        </div>
      </td>
    </tr>`).join("");

  const normalRounds = (rounds || []).filter(r => !r.title);
  const nextRoundNumber = normalRounds.length ? Math.max(...normalRounds.map(r=>r.round_number)) + 1 : 1;

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <b>ラウンド一覧</b>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>ラウンド</th><th>状態</th><th>日程</th><th></th><th></th></tr></thead>
        <tbody>${rows || ""}</tbody>
      </table>
    </div>
    <div class="card">
      <b>新しいラウンドを作成（第${nextRoundNumber}希望）</b>
      <p class="small-muted">学生は①〜⑥のうち、まだ決まっていないクールから自由に実習先を選んで希望を出せます。</p>
      <div style="margin:10px 0;">
        <label class="small-muted">開始日時</label>
        <input type="datetime-local" id="new-start" />
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">1次締切日時（この日時を過ぎると自動で抽選されます）</label>
        <input type="datetime-local" id="new-end" />
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">2次マッチング締切日時（1次抽選で外れた人の再提出締切。この日時を過ぎると自動で2次抽選されます）</label>
        <input type="datetime-local" id="new-second-deadline" />
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">1次確定後のキャンセル受付時間（任意。設定すると、1次で確定した学生がこの時間内だけ自分の確定枠をキャンセルして2次マッチングに回れます。1人1ラウンド1回まで、取り消し不可）</label>
        <input type="datetime-local" id="new-cancel-start" placeholder="開始" />
        <input type="datetime-local" id="new-cancel-end" placeholder="終了" />
      </div>
      <div style="margin:10px 0;">
        <p class="small-muted">氏名の公開ルール: 宿泊が絡まない施設は抽選確定まで自動的に匿名、宿泊が絡む施設は本人が任意のタイミングで公開できます（このラウンド作成では設定不要です）。</p>
      </div>
      <button id="create-round">作成して現在ラウンドにする</button>
    </div>
  `;

  document.querySelectorAll(".set-current").forEach(b => {
    b.onclick = async () => {
      await sb.from("rounds").update({ is_current: false }).neq("id", "00000000-0000-0000-0000-000000000000");
      await sb.from("rounds").update({ is_current: true }).eq("id", b.dataset.id);
      renderRoundsTab();
    };
  });

  document.querySelectorAll(".start-third").forEach(b => {
    b.onclick = async () => {
      const { count } = await sb
        .from("preferences")
        .select("student_id", { count: "exact", head: true })
        .eq("round_id", b.dataset.id)
        .eq("attempt", 2)
        .eq("status", "lost");
      const val = prompt(`このラウンドで2次マッチングにも外れた学生が${count || 0}人います。3次マッチングの締切日時を「YYYY-MM-DDTHH:MM」の形式で入力してください（例: 2026-09-30T12:00）`);
      if (!val) return;
      const iso = new Date(val).toISOString();
      if (isNaN(new Date(val).getTime())) { alert("日時の形式が正しくありません。"); return; }
      await sb.from("rounds").update({ is_current: false }).neq("id", "00000000-0000-0000-0000-000000000000");
      await sb.from("rounds").update({ phase: "third_match", third_deadline: iso, is_current: true }).eq("id", b.dataset.id);
      alert("3次マッチングを開始しました。対象の学生（2次マッチングで外れた学生）は、空いている枠から改めて希望を出せます。");
      renderRoundsTab();
    };
  });

  document.querySelectorAll(".save-times").forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const val = cls => {
        const el = document.querySelector(`.${cls}[data-id="${id}"]`);
        return el && el.value ? new Date(el.value).toISOString() : null;
      };
      const update = {
        start_at: val("time-start-input"),
        end_at: val("time-end-input"),
        second_deadline: val("time-second-input"),
      };
      if (document.querySelector(`.time-third-input[data-id="${id}"]`)) update.third_deadline = val("time-third-input");
      if (update.start_at && update.end_at && new Date(update.end_at) <= new Date(update.start_at)) {
        alert("1次締切は開始より後にしてください。"); return;
      }
      if (update.end_at && update.second_deadline && new Date(update.second_deadline) <= new Date(update.end_at)) {
        alert("2次締切は1次締切より後にしてください。"); return;
      }
      const { error } = await sb.from("rounds").update(update).eq("id", id);
      if (error) { alert("保存に失敗しました: " + error.message); return; }
      alert("日程を保存しました。");
      renderRoundsTab();
    };
  });

  document.querySelectorAll(".save-cancel-window").forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.id;
      const startInput = document.querySelector(`.cancel-start-input[data-id="${id}"]`);
      const endInput = document.querySelector(`.cancel-end-input[data-id="${id}"]`);
      const startIso = startInput.value ? new Date(startInput.value).toISOString() : null;
      const endIso = endInput.value ? new Date(endInput.value).toISOString() : null;
      await sb.from("rounds").update({ cancel_window_start: startIso, cancel_window_end: endIso }).eq("id", id);
      alert("キャンセル受付時間を保存しました。");
      renderRoundsTab();
    };
  });

  document.getElementById("create-round").onclick = async () => {
    const startVal = document.getElementById("new-start").value;
    const endVal = document.getElementById("new-end").value;
    const secondDeadlineVal = document.getElementById("new-second-deadline").value;
    const cancelStartVal = document.getElementById("new-cancel-start").value;
    const cancelEndVal = document.getElementById("new-cancel-end").value;
    await sb.from("rounds").update({ is_current: false }).neq("id", "00000000-0000-0000-0000-000000000000");
    await sb.from("rounds").insert({
      round_number: nextRoundNumber,
      display_order: nextRoundNumber,
      course_number: null,
      start_at: startVal ? new Date(startVal).toISOString() : null,
      end_at: endVal ? new Date(endVal).toISOString() : null,
      second_deadline: secondDeadlineVal ? new Date(secondDeadlineVal).toISOString() : null,
      cancel_window_start: cancelStartVal ? new Date(cancelStartVal).toISOString() : null,
      cancel_window_end: cancelEndVal ? new Date(cancelEndVal).toISOString() : null,
      is_current: true,
      phase: "first_choice",
    });
    renderRoundsTab();
  };
}

// ============================================================
// 集計・抽選（ラウンドのタームは固定なので、枠ごとの集計のみ）
// ============================================================
async function renderMatchingTab() {
  const { data: round0 } = await sb.from("rounds").select("*").eq("is_current", true).maybeSingle();
  if (!round0) {
    document.getElementById("tab-content").innerHTML = `<div class="notice info">現在のラウンドが設定されていません。「ラウンド管理」タブでラウンドを作成してください。</div>`;
    return;
  }

  const round = await window.tryRunLotteryIfDue(sb, round0);

  if (round.phase.endsWith("_processing")) {
    document.getElementById("tab-content").innerHTML = `<div class="notice info">現在、自動抽選を処理中です。数秒後に再読み込みしてください。</div>`;
    return;
  }

  const attempt = round.phase === "second_match" ? 2 : round.phase === "third_match" ? 3 : 1;
  const now = new Date();
  const relevantDeadline = attempt === 3 ? round.third_deadline : attempt === 2 ? round.second_deadline : round.end_at;
  const deadlinePassed = relevantDeadline && now > new Date(relevantDeadline);

  const { data: prefs } = await sb
    .from("preferences")
    .select("*, students(attendance_number, name), slots(facility_name, department_name, cap_1,cap_2,cap_3,cap_4,cap_5,cap_6)")
    .eq("round_id", round.id)
    .eq("attempt", attempt);

  // ===== 未回答者の一覧（10人を切ったら名前を表示） =====
  const { data: allStudentsForVoteCheck } = await sb.from("students").select("id, attendance_number, name");
  const { data: allAssignCountsForVoteCheck } = await sb.from("assignments").select("student_id");
  const assignCnt = {};
  (allAssignCountsForVoteCheck || []).forEach(a => { assignCnt[a.student_id] = (assignCnt[a.student_id] || 0) + 1; });

  let excludedIds = new Set();
  for (let a = 1; a < attempt; a++) {
    const { data: confirmedAtA } = await sb
      .from("preferences")
      .select("student_id")
      .eq("round_id", round.id)
      .eq("attempt", a)
      .eq("status", "confirmed");
    (confirmedAtA || []).forEach(p => excludedIds.add(p.student_id));
  }

  const eligibleStudents = (allStudentsForVoteCheck || []).filter(s => (assignCnt[s.id] || 0) < 6 && !excludedIds.has(s.id));
  const votedIds = new Set((prefs || []).map(p => p.student_id));
  const notVoted = eligibleStudents.filter(s => !votedIds.has(s.id)).sort((a,b) => a.attendance_number - b.attendance_number);

  let notVotedHtml = "";
  if (notVoted.length > 0 && notVoted.length < 10) {
    notVotedHtml = `<div class="card" style="border:2px solid #b3413a;">
      <b style="color:#b3413a;">未回答: 残り${notVoted.length}人</b>
      <p style="margin-top:6px;">${notVoted.map(s => `${s.attendance_number} ${esc(s.name)}`).join("、 ")}</p>
    </div>`;
  }

  // ===== キャンセル履歴（全ラウンド共通） =====
  const { data: cancelledPrefs } = await sb
    .from("preferences")
    .select("*, students(attendance_number, name), slots(facility_name, department_name), rounds(round_number, title)")
    .eq("cancelled", true)
    .order("created_at", { ascending: false });

  let cancelledHtml = "";
  if (cancelledPrefs && cancelledPrefs.length > 0) {
    cancelledHtml = `<div class="card">
      <b>キャンセル履歴</b>
      <table class="slots" style="margin-top:8px;">
        <thead><tr><th>学生</th><th>ラウンド</th><th>クール</th><th>キャンセルした枠</th></tr></thead>
        <tbody>
          ${cancelledPrefs.map(p => `
            <tr>
              <td>${p.students.attendance_number} ${esc(p.students.name)}</td>
              <td>${esc(roundLabel(p.rounds))}</td>
              <td>${window.COURSE_LABELS[p.course_number-1]}</td>
              <td>${esc(p.slots.facility_name)} ${esc(p.slots.department_name)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>`;
  }

  const groups = {};
  for (const p of (prefs || [])) {
    const key = p.slot_id + "_" + p.course_number;
    if (!groups[key]) {
      groups[key] = { slot: p.slots, courseNumber: p.course_number, cap: p.slots["cap_"+p.course_number], items: [] };
    }
    groups[key].items.push(p);
  }

  const groupList = Object.values(groups).sort((a,b)=>a.courseNumber-b.courseNumber);

  // ===== 全体表（①〜⑥クール × 全実習先、匿名関係なく全員の名前が見える） =====
  const { data: allSlots } = await sb.from("slots").select("*").eq("active", true);
  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, lodging_choice, students(attendance_number, name)");

  function requiresLodgingAdmin(slot) {
    const acc = slot.facility_accommodation || slot.accommodation || "";
    return acc.includes("○");
  }

  function buildGrid(institutionType, label) {
    const list = (allSlots || [])
      .filter(s => s.institution_type === institutionType)
      .sort((a,b) => a.sort_order - b.sort_order);
    if (list.length === 0) return "";

    let rows = "";
    let prevFacility = null;
    for (const s of list) {
      const facilityChanged = institutionType === "external" && s.facility_name !== prevFacility;
      prevFacility = s.facility_name;
      const rowClass = s.category === "internal_medicine" ? "row-naika" : "row-geka";
      const lodgingRow = requiresLodgingAdmin(s);
      rows += `<tr class="${rowClass} ${facilityChanged ? 'facility-start' : ''}"><td class="dept-col"><b>${esc(s.facility_name)}</b><br/>${esc(s.department_name)}${lodgingRow ? '<br/><span class="lodging-badge">🏨宿泊あり</span>' : ''}</td>`;
      for (let c = 1; c <= 6; c++) {
        const cap = s["cap_" + c];
        if (cap <= 0) { rows += `<td class="cell-slot cell-blocked">×</td>`; continue; }
        const confirmedHere = (allAssignments || []).filter(a => a.slot_id === s.id && a.course_number === c);
        const pendingHere = (prefs || []).filter(p => p.slot_id === s.id && p.course_number === c && p.status !== "confirmed");
        const total = confirmedHere.length + pendingHere.length;
        const lodgingTag = (a) => {
          if (!lodgingRow) return "";
          if (a.lodging_choice === "yes") return ' <span class="lodging-badge-answered">宿泊する</span>';
          if (a.lodging_choice === "no") return ' <span class="lodging-badge-answered">宿泊しない</span>';
          return ' <span class="lodging-badge-unanswered">宿泊未回答</span>';
        };
        const names = [
          ...confirmedHere.map(a => `<b>${a.students.attendance_number} ${esc(a.students.name)}</b>${lodgingTag(a)}`),
          ...pendingHere.map(p => `${p.students.attendance_number} ${esc(p.students.name)}(${p.status})`),
        ].join("<br>");
        const overflowClass = total > cap ? "frame-over" : (total === cap ? "frame-exact" : "");
        rows += `<td class="cell-slot ${overflowClass}"><div class="cell-cap">${total}/${cap}</div>${names ? `<div class="cell-names">${names}</div>` : ""}</td>`;
      }
      rows += `</tr>`;
    }
    const header = `<tr><th class="dept-col">実習先/診療科</th>${window.COURSE_LABELS.map((l,i)=>`<th>${l}<br/><span class="course-date">${window.COURSE_DATES[i]}</span></th>`).join("")}</tr>`;
    return `<div class="card">
      <b>${label}の全体表（管理者用・氏名は常に表示）</b>
      <div class="grid-scroll" style="margin-top:8px;">
        <table class="pref-grid"><thead>${header}</thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
  }

  const gridHtml = buildGrid("internal", "院内") + buildGrid("external", "院外");

  let rows = groupList.map(g => {
    const overflow = g.items.length > g.cap;
    const names = g.items.map(i => `${i.students.attendance_number} ${esc(i.students.name)}${i.status!=='submitted' ? `(${i.status})` : ''}`).join("、 ");
    return `<tr class="${overflow?'overflow':''}">
      <td>${window.COURSE_LABELS[g.courseNumber-1]}</td>
      <td>${esc(g.slot.facility_name)} ${esc(g.slot.department_name)}</td>
      <td class="cap">${g.items.length} / ${g.cap}</td>
      <td class="small-muted">${names}</td>
    </tr>`;
  }).join("");

  document.getElementById("tab-content").innerHTML = `
    ${notVotedHtml}
    ${cancelledHtml}
    ${gridHtml}
    <div class="card">
      <div class="flex-between">
        <b>${esc(roundLabel(round))}（${attempt===3?'3次マッチング':attempt===2?'2次マッチング':'1次'}）の集計</b>
        <span class="small-muted">状態: ${round.phase}</span>
      </div>
      <p class="small-muted">${relevantDeadline ? `締切: ${new Date(relevantDeadline).toLocaleString("ja-JP")}${deadlinePassed ? '（締切超過 — 通常は自動で抽選されます）' : '（締切前は自由に希望を出せます。定員オーバーもOK）'}` : "締切未設定"}</p>
      <p class="small-muted">対象者 ${eligibleStudents.length}人中 ${votedIds.size}人が回答済み（未回答 ${notVoted.length}人）</p>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>クール</th><th>実習先</th><th>希望者数/定員</th><th>希望者</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="small-muted">まだ希望の提出がありません</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <b>抽選・確定処理</b>
      <p class="small-muted">通常は締切を過ぎると自動で実行されます（誰かがページを開いたタイミングで処理されます）。締切前でも今すぐ確定したい場合はこちらのボタンで手動実行できます。</p>
      <button id="run-lottery">今すぐ抽選を実行する</button>
      <div id="lottery-result" class="small-muted" style="margin-top:8px;"></div>
    </div>
  `;

  document.getElementById("run-lottery").onclick = async () => {
    const btn = document.getElementById("run-lottery");
    btn.disabled = true;
    btn.textContent = "処理中...";
    const result = await window.runLotteryCore(sb, round, round.phase === "second_match" ? "second_match" : "first_choice");
    document.getElementById("lottery-result").textContent = `完了：確定 ${result.confirmedCount}件 / 抽選漏れ ${result.lostCount}件`;
    btn.textContent = "今すぐ抽選を実行する";
    btn.disabled = false;
    renderMatchingTab();
  };
}

checkAuth();
