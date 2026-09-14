const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const appEl = document.getElementById("app");
const headerEl = document.getElementById("student-name-header");

const CATEGORY_LABEL = { internal_medicine: "内科系", surgery: "外科系" };
const INSTITUTION_LABEL = { internal: "院内", external: "院外" };
const COMBO_LABEL = { IN_N: "院内・内科系", IN_G: "院内・外科系", EX_N: "院外・内科系", EX_G: "院外・外科系" };

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function fmtDate(d) {
  return new Date(d).toLocaleString("ja-JP");
}

function requiresLodging(slot) {
  const acc = slot.facility_accommodation || slot.accommodation || "";
  return acc.includes("○");
}

function comboKeyOf(slot) {
  const inst = slot.institution_type === "internal" ? "IN" : "EX";
  const cat = slot.category === "internal_medicine" ? "N" : "G";
  return inst + "_" + cat;
}

// 4つの組み合わせ(院内内科・院内外科・院外内科・院外外科)は必ず1回以上、
// 残り2つは「院内内科+院外外科をもう1回ずつ」または「院外内科+院内外科をもう1回ずつ」
// の2パターンしかない。counts={IN_N,IN_G,EX_N,EX_G} に対し、まだ成立しうる配分(a)を返す。
function feasiblePatterns(counts) {
  const patterns = [1, 2]; // a=1→(1,2,2,1), a=2→(2,1,1,2)
  return patterns.filter(a => {
    const target = { IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a };
    return Object.keys(target).every(k => counts[k] <= target[k]);
  });
}

function comboEligible(counts, comboKey, feasible) {
  return feasible.some(a => {
    const target = { IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a };
    return counts[comboKey] < target[comboKey];
  });
}

// ============================================================
// 施設詳細モーダル
// ============================================================
function ensureModalRoot() {
  if (document.getElementById("facility-modal-root")) return;
  const div = document.createElement("div");
  div.id = "facility-modal-root";
  document.body.appendChild(div);
}
function closeFacilityModal() {
  const root = document.getElementById("facility-modal-root");
  if (root) root.innerHTML = "";
}
function openFacilityModal(info) {
  ensureModalRoot();
  const root = document.getElementById("facility-modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-box">
        <div class="flex-between">
          <b>${esc(info.facility_name)}</b>
          <button class="small secondary" id="modal-close">閉じる</button>
        </div>
        <table class="slots" style="margin-top:10px;">
          <tbody>
            <tr><td style="width:90px;"><b>宿泊施設</b></td><td>${esc(info.accommodation) || "情報なし"}</td></tr>
            <tr><td><b>集合時間</b></td><td>${esc(info.gather_time) || "情報なし"}</td></tr>
            ${info.limit_note ? `<tr><td><b>人数上限</b></td><td>${esc(info.limit_note)}</td></tr>` : ""}
            ${requiresLodging(info) ? `<tr><td><b>氏名公開</b></td><td>宿泊調整が必要な施設です。この施設への希望は、本人が「公開する」を選べば匿名期間中でも氏名が見えるようになります。</td></tr>` : ""}
          </tbody>
        </table>
        <div style="margin-top:10px;">
          <b class="small-muted">実習先からの連絡事項等</b>
          <p class="note-text" style="margin-top:6px;">${esc(info.note) || "特になし"}</p>
        </div>
      </div>
    </div>
  `;
  document.getElementById("modal-close").onclick = closeFacilityModal;
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeFacilityModal();
  });
}

async function main() {
  const token = getToken();
  if (!token) {
    appEl.innerHTML = `<div class="notice warn">個人専用のURLからアクセスしてください。URLに ?token=... が含まれている必要があります。</div>`;
    headerEl.textContent = "";
    return;
  }

  const { data: student, error: studentErr } = await sb
    .from("students")
    .select("*")
    .eq("access_token", token)
    .maybeSingle();

  if (studentErr || !student) {
    appEl.innerHTML = `<div class="notice warn">リンクが無効です。事務局にお問い合わせください。</div>`;
    headerEl.textContent = "";
    return;
  }

  headerEl.textContent = `${student.name}（出席番号 ${student.attendance_number}）`;

  const { data: round0 } = await sb
    .from("rounds")
    .select("*")
    .eq("is_current", true)
    .maybeSingle();

  const round = await window.tryRunLotteryIfDue(sb, round0);

  const { data: assignments } = await sb
    .from("assignments")
    .select("course_number, slot_id, slots(institution_type, category, facility_name, department_name)")
    .eq("student_id", student.id);

  renderApp(student, round, assignments || []);
}

function computeState(assignments) {
  const counts = { IN_N: 0, IN_G: 0, EX_N: 0, EX_G: 0 };
  const filledCourses = new Set();
  for (const a of assignments) {
    filledCourses.add(a.course_number);
    counts[comboKeyOf(a.slots)]++;
  }
  return { counts, filledCourses };
}

async function renderApp(student, round, assignments) {
  const { counts, filledCourses } = computeState(assignments);
  const allDone = filledCourses.size >= 6;
  const feasible = feasiblePatterns(counts);

  let html = "";

  // ステータスパネル：6マスを埋める進捗として表示
  html += `<div class="card">
    <div class="combo-status">
      ${["IN_N", "IN_G", "EX_N", "EX_G"].map(k => `
        <div class="combo-box ${counts[k] > 0 ? 'done' : ''}">
          <div class="combo-num">${counts[k]}</div>
          <div class="combo-label">${COMBO_LABEL[k]}</div>
        </div>
      `).join("")}
    </div>
    <div class="small-muted" style="margin-top:8px;">確定クール: ${filledCourses.size} / 6　（院内内科・院内外科・院外内科・院外外科を最低1回ずつ、残り2回は「院内内科+院外外科」または「院外内科+院内外科」のどちらかの組み合わせで埋まります）</div>
  </div>`;

  if (assignments.length > 0) {
    html += `<div class="card"><b>確定済みの実習先</b><table class="slots" style="margin-top:8px;"><thead><tr><th>クール</th><th>区分</th><th>実習先</th></tr></thead><tbody>`;
    for (const a of assignments.slice().sort((x,y)=>x.course_number-y.course_number)) {
      html += `<tr><td>${window.COURSE_LABELS[a.course_number-1]}</td><td>${INSTITUTION_LABEL[a.slots.institution_type]}/${CATEGORY_LABEL[a.slots.category]}</td><td>${esc(a.slots.facility_name)} ${esc(a.slots.department_name)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  if (allDone) {
    html += `<div class="notice confirmed">すべてのクールが確定しました。お疲れ様でした。</div>`;
    appEl.innerHTML = html;
    return;
  }

  if (!round) {
    html += `<div class="notice info">現在、募集中のラウンドはありません。事務局からの案内をお待ちください。</div>`;
    appEl.innerHTML = html;
    return;
  }

  const now = new Date();

  html += `<div class="card"><b>現在のラウンド：第${round.round_number}希望</b>`;
  if (round.start_at) html += `<div class="small-muted">開始: ${fmtDate(round.start_at)}</div>`;
  if (round.end_at) html += `<div class="small-muted">1次締切: ${fmtDate(round.end_at)}</div>`;
  if (round.second_deadline) html += `<div class="small-muted">2次締切: ${fmtDate(round.second_deadline)}</div>`;
  html += `</div>`;

  const notStarted = round.start_at && now < new Date(round.start_at);
  const firstEnded = round.end_at && now > new Date(round.end_at);
  const secondEnded = round.second_deadline && now > new Date(round.second_deadline);

  let canEdit = false;
  let myPref = null;
  let attempt = round.phase === "second_match" ? 2 : 1;

  if (notStarted) {
    html += `<div class="notice info">このラウンドはまだ開始していません。開始をお待ちください。</div>`;
    appEl.innerHTML = html;
    return;
  }

  const { data: pref } = await sb
    .from("preferences")
    .select("*, slots(facility_name, department_name, facility_accommodation, accommodation)")
    .eq("student_id", student.id)
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .maybeSingle();
  myPref = pref;

  let statusNotice = "";
  if (round.phase === "closed") {
    statusNotice = `<div class="notice info">このラウンドは終了しました。次のラウンドをお待ちください。</div>`;
  } else if (round.phase === "first_choice" && firstEnded) {
    statusNotice = `<div class="notice info">1次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
  } else if (round.phase === "second_match" && secondEnded) {
    statusNotice = `<div class="notice info">2次締切時刻を過ぎました。まもなく自動で抽選が行われます。少し時間をおいて再読み込みしてください。</div>`;
  } else if (attempt === 1) {
    if (!myPref || myPref.status === "submitted") {
      canEdit = true;
      if (myPref) statusNotice = `<div class="notice confirmed">${window.COURSE_LABELS[myPref.course_number-1]}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を希望として提出済みです。表をタップすると変更できます。</div>`;
    } else if (myPref.status === "confirmed") {
      statusNotice = `<div class="notice confirmed">今回の希望は確定しました。次のラウンドをお待ちください。</div>`;
    } else if (myPref.status === "lost") {
      statusNotice = `<div class="notice warn">第一希望は抽選の結果、埋まってしまいました。事務局が2次マッチングを開始するまでお待ちください。</div>`;
    }
  } else {
    if (!myPref) {
      canEdit = true;
      statusNotice = `<div class="notice warn">抽選の結果、埋まってしまいました。空いている枠から2次希望を選んでください。</div>`;
    } else if (myPref.status === "submitted") {
      canEdit = true;
      statusNotice = `<div class="notice confirmed">2次希望として「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を提出済みです。表をタップすると変更できます。</div>`;
    } else if (myPref.status === "confirmed") {
      statusNotice = `<div class="notice confirmed">2次希望が確定しました。次のラウンドをお待ちください。</div>`;
    } else {
      statusNotice = `<div class="notice warn">2次希望も埋まってしまいました。事務局にご相談ください。</div>`;
    }
  }
  html += statusNotice;

  const myPrefLodging = myPref && myPref.slots && requiresLodging(myPref.slots);
  if (myPref && (myPref.status === "submitted" || myPref.status === "lottery") && !myPref.reveal_self && myPrefLodging) {
    html += `<div class="card">
      <div class="flex-between">
        <span class="small-muted">宿泊調整が必要な施設です。今の希望を他の学生にも公開して、部屋割りなどの話し合いをしやすくできます。</span>
        <button class="small secondary" id="reveal-self-btn">自分の名前を公開する</button>
      </div>
    </div>`;
  }

  if (feasible.length === 1) {
    const a = feasible[0];
    const target = { IN_N: a, IN_G: 3 - a, EX_N: 3 - a, EX_G: a };
    const remainMsg = ["IN_N","IN_G","EX_N","EX_G"]
      .filter(k => counts[k] < target[k])
      .map(k => COMBO_LABEL[k]);
    if (remainMsg.length > 0) {
      html += `<div class="notice warn">組み合わせの都合上、残りは「${remainMsg.join("・")}」から選ぶ必要があります。</div>`;
    }
  }

  appEl.innerHTML = html;

  if (myPref && (myPref.status === "submitted" || myPref.status === "lottery") && !myPref.reveal_self && myPrefLodging) {
    document.getElementById("reveal-self-btn").onclick = async () => {
      if (!confirm("自分の名前を公開します。一度公開すると匿名には戻せません。よろしいですか？")) return;
      await sb.from("preferences").update({ reveal_self: true }).eq("id", myPref.id);
      location.reload();
    };
  }

  const { data: slots } = await sb.from("slots").select("*").eq("active", true);
  const { data: facilityLimits } = await sb.from("facility_limits").select("*");
  const limitMap = {};
  (facilityLimits || []).forEach(f => { limitMap[f.facility_name] = f; });

  const { data: roundPrefs } = await sb
    .from("preferences")
    .select("slot_id, course_number, status, reveal_self, student_id, students(attendance_number, name)")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .in("status", ["submitted", "lottery", "confirmed"]);

  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, students(attendance_number, name)");

  const facilityCourseCount = {};
  const facilityConfirmedCount = {};
  for (const s of slots) {
    if (s.institution_type !== "external") continue;
    for (let c = 1; c <= 6; c++) {
      const confirmedN = allAssignments.filter(a => a.slot_id === s.id && a.course_number === c).length;
      const pendingN = roundPrefs.filter(p => p.slot_id === s.id && p.course_number === c && p.status !== "confirmed").length;
      const key = s.facility_name + "_" + c;
      facilityCourseCount[key] = (facilityCourseCount[key] || 0) + confirmedN + pendingN;
      facilityConfirmedCount[key] = (facilityConfirmedCount[key] || 0) + confirmedN;
    }
  }

  const globalRevealed = !round.reveal_at || now >= new Date(round.reveal_at);

  renderLegend(globalRevealed);
  renderFullGrid("internal", "院内", slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses);
  renderFullGrid("external", "院外", slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses);
}

function renderLegend(globalRevealed) {
  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="legend">
        <span><span class="sw" style="background:#fff2a8;border:1px solid #d8c463;"></span>内科系</span>
        <span><span class="sw" style="background:#b9e6b5;border:1px solid #7fc27a;"></span>外科系</span>
        <span><span class="sw" style="background:#fceccb;border:2px solid #d99a3a;"></span>ちょうど定員</span>
        <span><span class="sw" style="background:#fbeceb;border:2px solid #b3413a;"></span>定員超過中(それでも選択可)</span>
        <span><span class="sw" style="background:#dcdcdc;"></span>受入不可/対象者限定</span>
        <span><span class="sw" style="background:#ede4f7;border:2px solid #7b4fb8;"></span>あなたの希望</span>
      </div>
      <p class="small-muted">院外の表は、同じ病院ごとに太線で区切っています。施設名をタップすると、宿泊・集合時間・連絡事項の詳細が見られます。定員を超えていても締切までは希望を出せ、締切後に自動で抽選されます。宿泊が絡まない施設の希望者は、抽選で確定するまで氏名は表示されません（人数のみ）。宿泊が絡む施設は、本人が希望すれば匿名期間中でも公開できます。</p>
    </div>
  `);
}

function renderFullGrid(institutionType, label, slots, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses) {
  const list = slots
    .filter(s => s.institution_type === institutionType)
    .sort((a, b) => a.sort_order - b.sort_order);

  if (list.length === 0) return;

  let rows = "";
  let prevFacility = null;
  for (const s of list) {
    const rowClass = s.category === "internal_medicine" ? "row-naika" : "row-geka";
    const facilityChanged = institutionType === "external" && s.facility_name !== prevFacility;
    prevFacility = s.facility_name;
    const limit = limitMap[s.facility_name];
    const limitBadge = limit ? `<div class="facility-limit-badge">🛈 施設全体1クールあたり最大${limit.max_total}名まで</div>` : "";
    rows += `<tr class="${rowClass} ${facilityChanged ? 'facility-start' : ''}"><td class="dept-col facility-tap" data-facility="${esc(s.facility_name)}"><b class="facility-name">${esc(s.facility_name)}</b><br/>${esc(s.department_name)}${limitBadge}</td>`;
    for (let c = 1; c <= 6; c++) {
      rows += renderCell(s, c, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses);
    }
    rows += `</tr>`;
  }

  const header = `<tr><th class="dept-col">実習先 / 診療科</th>${window.COURSE_LABELS.map(l => `<th>${l}</th>`).join("")}</tr>`;

  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <b>${label}の実習先</b>
      <div class="grid-scroll" style="margin-top:8px;">
        <table class="pref-grid">
          <thead>${header}</thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `);

  document.querySelectorAll(`td.cell-open[data-institution="${institutionType}"]`).forEach(td => {
    td.addEventListener("click", () => onCellClick(td, student, round, attempt, myPref));
  });

  document.querySelectorAll(`td.facility-tap`).forEach(td => {
    td.addEventListener("click", () => {
      const fname = td.dataset.facility;
      const slot = list.find(s => s.facility_name === fname);
      if (!slot) return;
      const limit = limitMap[fname];
      openFacilityModal({
        facility_name: fname,
        accommodation: slot.facility_accommodation || slot.accommodation,
        gather_time: slot.facility_gather_time || slot.gather_time,
        note: slot.facility_note || slot.note,
        limit_note: limit ? `${limit.note}（1クールあたり施設全体で最大${limit.max_total}名）` : "",
      });
    });
  });
}

function renderCell(slot, courseNumber, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, counts, feasible, globalRevealed, limitMap, facilityCourseCount, facilityConfirmedCount, filledCourses) {
  const cap = slot["cap_" + courseNumber];
  const isKuroshio = slot.department_name.includes("黒潮医療人養成プロジェクト") || slot.facility_name.includes("黒潮医療人養成プロジェクト");

  if (cap <= 0) {
    return `<td class="cell-slot cell-blocked">×</td>`;
  }
  if (isKuroshio) {
    const kuroshioConfirmed = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);
    const kuroshioNames = kuroshioConfirmed.map(a => `<b>${esc(a.students.name)}</b>`).join("<br>");
    return `<td class="cell-slot cell-blocked">
      <div class="cell-cap">対象者のみ</div>
      ${kuroshioNames ? `<div class="cell-names">${kuroshioNames}</div>` : ""}
    </td>`;
  }

  const confirmedHere = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);

  if (filledCourses.has(courseNumber)) {
    const namesHtml = confirmedHere.map(a =>
      a.students.attendance_number === student.attendance_number
        ? `<span class="me-confirmed">✔ ${esc(a.students.name)}(あなた)</span>`
        : `<b>${esc(a.students.name)}</b>`
    ).join("<br>");
    return `<td class="cell-slot cell-other-term">
      <div class="cell-cap">${confirmedHere.length}/${cap}</div>
      ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
    </td>`;
  }

  const isMine = !!(myPref && myPref.slot_id === slot.id && myPref.course_number === courseNumber &&
    (myPref.status === "submitted" || myPref.status === "lottery"));
  const pendingHere = roundPrefs.filter(p => p.slot_id === slot.id && p.course_number === courseNumber && p.status !== "confirmed");
  const totalCount = confirmedHere.length + pendingHere.length;
  const isExactFull = totalCount === cap;
  const isOverFull = totalCount > cap;
  const confirmedFull = confirmedHere.length >= cap;

  const facilityLimit = limitMap[slot.facility_name];
  const facKey = slot.facility_name + "_" + courseNumber;
  const facCount = facilityCourseCount[facKey] || 0;
  const facilityExact = facilityLimit && facCount === facilityLimit.max_total;
  const facilityOver = facilityLimit && facCount > facilityLimit.max_total;
  const facilityConfirmedFull = facilityLimit && (facilityConfirmedCount[facKey] || 0) >= facilityLimit.max_total;

  const lodging = requiresLodging(slot);

  const confirmedNamesHtml = confirmedHere.map(a => `<b>${esc(a.students.name)}</b>`).join("<br>");

  // 匿名ルール：
  // ・宿泊が絡む施設 → 本人が公開ボタンを押した人、または既に公開済みの人は名前表示。それ以外は人数のみ。
  // ・宿泊が絡まない施設 → 抽選確定(confirmed)するまでは絶対に名前を出さない（自分自身の分を除く）。
  let pendingNamesHtml = "";
  if (lodging) {
    const shown = [];
    let hiddenCount = 0;
    for (const p of pendingHere) {
      if (p.student_id === student.id) shown.push(`<b>あなた</b>`);
      else if (p.reveal_self) shown.push(esc(p.students.name));
      else hiddenCount++;
    }
    if (hiddenCount > 0) shown.push(`${hiddenCount}名希望中`);
    pendingNamesHtml = shown.join("<br>");
  } else {
    const shown = [];
    let hiddenCount = 0;
    for (const p of pendingHere) {
      if (p.student_id === student.id) shown.push(`<b>あなた</b>`);
      else hiddenCount++;
    }
    if (hiddenCount > 0) shown.push(`${hiddenCount}名希望中`);
    pendingNamesHtml = shown.join("<br>");
  }
  const namesHtml = [confirmedNamesHtml, pendingNamesHtml].filter(Boolean).join("<br>");

  if (confirmedFull || facilityConfirmedFull) {
    const label = confirmedFull ? "満員(確定)" : "施設全体満員(確定)";
    return `<td class="cell-slot cell-full">
      <div class="cell-cap">${totalCount}/${cap}</div>
      <div class="cell-names">${label}</div>
      ${confirmedNamesHtml ? `<div class="cell-names">${confirmedNamesHtml}</div>` : ""}
    </td>`;
  }

  const combo = comboKeyOf(slot);
  let eligible = canEdit && comboEligible(counts, combo, feasible);

  let cls = "cell-slot";
  if (eligible) cls += " cell-open";
  else cls += " cell-ineligible";

  if (isOverFull || facilityOver) cls += " cell-overflow";
  else if (isExactFull || facilityExact) cls += " cell-overbook";

  if (isMine) cls += " cell-mine";

  const dataAttrs = eligible
    ? `data-slot="${slot.id}" data-course="${courseNumber}" data-institution="${slot.institution_type}" data-facility="${esc(slot.facility_name)}" data-dept="${esc(slot.department_name)}"`
    : "";

  let overNote = "";
  if (isOverFull || facilityOver) overNote = `<div class="cell-names" style="color:#b3413a;">定員超過中</div>`;

  return `<td class="${cls}" ${dataAttrs}>
    <div class="cell-cap">${totalCount}/${cap}</div>
    ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
    ${overNote}
  </td>`;
}

async function onCellClick(td, student, round, attempt, myPref) {
  const slotId = td.dataset.slot;
  const courseNumber = Number(td.dataset.course);
  const facility = td.dataset.facility;
  const dept = td.dataset.dept;
  const courseLabel = window.COURSE_LABELS[courseNumber - 1];

  const ok = confirm(`${courseLabel}「${facility} ${dept}」を希望として提出します。よろしいですか？`);
  if (!ok) return;

  td.style.opacity = "0.5";

  if (myPref) {
    const { error } = await sb.from("preferences")
      .update({ slot_id: slotId, course_number: courseNumber, status: "submitted" })
      .eq("id", myPref.id);
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  } else {
    const { error } = await sb.from("preferences").insert({
      student_id: student.id,
      round_id: round.id,
      slot_id: slotId,
      course_number: courseNumber,
      attempt: attempt,
      status: "submitted",
    });
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  }
  location.reload();
}

main();
