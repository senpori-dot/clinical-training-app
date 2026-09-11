const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const appEl = document.getElementById("app");
const headerEl = document.getElementById("student-name-header");

const CATEGORY_LABEL = { internal_medicine: "内科系", surgery: "外科系" };
const INSTITUTION_LABEL = { internal: "院内", external: "院外" };

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
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

  const { data: round } = await sb
    .from("rounds")
    .select("*")
    .eq("is_current", true)
    .maybeSingle();

  const { data: assignments } = await sb
    .from("assignments")
    .select("course_number, slot_id, slots(institution_type, category, facility_name, department_name)")
    .eq("student_id", student.id);

  renderApp(student, round, assignments || []);
}

function computeRemaining(assignments) {
  const counts = { internal: 0, external: 0, internal_medicine: 0, surgery: 0 };
  const filledCourses = new Set();
  for (const a of assignments) {
    filledCourses.add(a.course_number);
    counts[a.slots.institution_type]++;
    counts[a.slots.category]++;
  }
  return {
    remaining: {
      internal: window.REQUIRED.internal - counts.internal,
      external: window.REQUIRED.external - counts.external,
      internal_medicine: window.REQUIRED.internal_medicine - counts.internal_medicine,
      surgery: window.REQUIRED.surgery - counts.surgery,
    },
    filledCourses,
  };
}

async function renderApp(student, round, assignments) {
  const { remaining, filledCourses } = computeRemaining(assignments);
  const allDone = filledCourses.size >= 6;

  let html = "";

  html += `<div class="card">
    <div class="status-grid">
      <div class="status-box ${remaining.internal<=0?'full':''}"><div class="num">${remaining.internal}</div><div class="label">院内 残り</div></div>
      <div class="status-box ${remaining.external<=0?'full':''}"><div class="num">${remaining.external}</div><div class="label">院外 残り</div></div>
      <div class="status-box ${remaining.internal_medicine<=0?'full':''}"><div class="num">${remaining.internal_medicine}</div><div class="label">内科系 残り</div></div>
      <div class="status-box ${remaining.surgery<=0?'full':''}"><div class="num">${remaining.surgery}</div><div class="label">外科系 残り</div></div>
    </div>
    <div class="small-muted">確定クール: ${filledCourses.size} / 6</div>
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

  const attempt = round.phase === "second_match" ? 2 : 1;

  const { data: myPref } = await sb
    .from("preferences")
    .select("*, slots(facility_name, department_name)")
    .eq("student_id", student.id)
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .maybeSingle();

  html += `<div class="card"><b>現在のラウンド：第${round.round_number}希望</b>`;
  if (round.deadline) {
    html += `<div class="small-muted">提出期限: ${new Date(round.deadline).toLocaleString("ja-JP")}</div>`;
  }
  html += `</div>`;

  // 編集可否の判定
  let canEdit = false;
  let statusNotice = "";

  if (round.phase === "closed") {
    statusNotice = `<div class="notice info">このラウンドは終了しました。次のラウンドをお待ちください。</div>`;
  } else if (attempt === 1) {
    if (!myPref || myPref.status === "submitted") {
      canEdit = true;
      if (myPref) statusNotice = `<div class="notice confirmed">${window.COURSE_LABELS[myPref.course_number-1]}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を希望として提出済みです。表をタップすると変更できます。</div>`;
    } else if (myPref.status === "confirmed") {
      statusNotice = `<div class="notice confirmed">このラウンドの希望は確定しました。次のラウンドをお待ちください。</div>`;
    } else if (myPref.status === "lost") {
      statusNotice = `<div class="notice warn">第一希望は抽選の結果、埋まってしまいました。事務局が2次マッチングを開始するまでお待ちください。</div>`;
    }
  } else {
    // attempt === 2 (second_match)
    if (!myPref) {
      canEdit = true;
      statusNotice = `<div class="notice warn">第一希望は抽選の結果、埋まってしまいました。空いている枠から2次希望を選んでください。</div>`;
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
  appEl.innerHTML = html;

  const { data: slots } = await sb.from("slots").select("*").eq("active", true);

  const { data: roundPrefs } = await sb
    .from("preferences")
    .select("slot_id, course_number, status, students(attendance_number, name)")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .in("status", ["submitted", "lottery", "confirmed"]);

  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, students(attendance_number, name)");

  renderLegend();
  renderGrid("internal", "院内", slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, remaining, filledCourses);
  renderGrid("external", "院外", slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, remaining, filledCourses);
}

function renderLegend() {
  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="legend">
        <span><span class="sw" style="background:#fff8dc;border:1px solid #e0d9a0;"></span>内科系</span>
        <span><span class="sw" style="background:#e3f3e2;border:1px solid #b9dab6;"></span>外科系</span>
        <span><span class="sw" style="background:#f6dede;"></span>満員</span>
        <span><span class="sw" style="background:#dcdcdc;"></span>受入不可</span>
        <span><span class="sw" style="background:#d9f0e8;border:2px solid #2e7d6b;"></span>あなたの希望</span>
      </div>
      <p class="small-muted">セル内は「希望者数/定員」と出席番号です。太字は確定者、通常字は希望提出中の学生です。空いているセルをタップすると、そのクール・実習先を希望として提出できます。</p>
    </div>
  `);
}

function renderGrid(institutionType, label, slots, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, remaining, filledCourses) {
  const list = slots
    .filter(s => s.institution_type === institutionType)
    .sort((a, b) => (a.facility_name + a.department_name).localeCompare(b.facility_name + b.department_name, "ja"));

  if (list.length === 0) return;

  let rows = "";
  for (const s of list) {
    const rowClass = s.category === "internal_medicine" ? "row-naika" : "row-geka";
    rows += `<tr class="${rowClass}"><td class="dept-col"><b>${esc(s.facility_name)}</b><br/>${esc(s.department_name)}</td>`;
    for (let c = 1; c <= 6; c++) {
      rows += renderCell(s, c, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, remaining, filledCourses);
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
}

function renderCell(slot, courseNumber, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, remaining, filledCourses) {
  const cap = slot["cap_" + courseNumber];

  if (cap <= 0) {
    return `<td class="cell-slot cell-blocked">×</td>`;
  }

  const isMine = !!(myPref && myPref.slot_id === slot.id && myPref.course_number === courseNumber &&
    (myPref.status === "submitted" || myPref.status === "lottery"));

  const confirmedHere = allAssignments.filter(a => a.slot_id === slot.id && a.course_number === courseNumber);
  const pendingHere = roundPrefs.filter(p => p.slot_id === slot.id && p.course_number === courseNumber && p.status !== "confirmed");

  const namesHtml = [
    ...confirmedHere.map(a => `<b>${a.students.attendance_number}</b>`),
    ...pendingHere.map(p => `${p.students.attendance_number}`),
  ].join(", ");

  const totalCount = confirmedHere.length + pendingHere.length;
  const isFull = totalCount >= cap && !isMine;

  const courseAlreadyFilledByMe = filledCourses.has(courseNumber);

  const eligible = canEdit && !courseAlreadyFilledByMe && !isFull && (
    (slot.institution_type === "internal" && remaining.internal > 0) ||
    (slot.institution_type === "external" && remaining.external > 0)
  ) && (
    (slot.category === "internal_medicine" && remaining.internal_medicine > 0) ||
    (slot.category === "surgery" && remaining.surgery > 0)
  );

  let cls = "cell-slot";
  if (isMine) cls += " cell-mine";
  else if (isFull) cls += " cell-full";
  else if (courseAlreadyFilledByMe) cls += " cell-col-filled";
  else if (eligible) cls += " cell-open";
  else cls += " cell-ineligible";

  const dataAttrs = eligible
    ? `data-slot="${slot.id}" data-course="${courseNumber}" data-institution="${slot.institution_type}" data-facility="${esc(slot.facility_name)}" data-dept="${esc(slot.department_name)}"`
    : "";

  return `<td class="${cls}" ${dataAttrs}>
    <div class="cell-cap">${totalCount}/${cap}</div>
    ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
  </td>`;
}

async function onCellClick(td, student, round, attempt, myPref) {
  const slotId = td.dataset.slot;
  const courseNumber = Number(td.dataset.course);
  const facility = td.dataset.facility;
  const dept = td.dataset.dept;
  const label = window.COURSE_LABELS[courseNumber - 1];

  const ok = confirm(`${label}「${facility} ${dept}」を希望として提出します。よろしいですか？`);
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
