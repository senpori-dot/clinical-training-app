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

function fmtDate(d) {
  return new Date(d).toLocaleString("ja-JP");
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

  if (!round || !round.course_number) {
    html += `<div class="notice info">現在、募集中のラウンドはありません。事務局からの案内をお待ちください。</div>`;
    appEl.innerHTML = html;
    return;
  }

  const courseNumber = round.course_number;
  const courseLabel = window.COURSE_LABELS[courseNumber - 1];
  const now = new Date();

  if (filledCourses.has(courseNumber)) {
    html += `<div class="card"><b>現在のラウンド：${courseLabel}（第${round.round_number}ラウンド）</b></div>`;
    html += `<div class="notice confirmed">${courseLabel}はすでに決定済みです。今回のラウンドではあなたの操作は不要です。次のラウンドをお待ちください。</div>`;
    appEl.innerHTML = html;
    return;
  }

  html += `<div class="card"><b>現在のラウンド：${courseLabel}（第${round.round_number}ラウンド）</b>`;
  if (round.start_at) html += `<div class="small-muted">開始: ${fmtDate(round.start_at)}</div>`;
  if (round.end_at) html += `<div class="small-muted">終了(締切): ${fmtDate(round.end_at)}</div>`;
  if (round.reveal_at) {
    const revealed = now >= new Date(round.reveal_at);
    html += `<div class="small-muted">${revealed ? `氏名は ${fmtDate(round.reveal_at)} に公開されました` : `氏名の公開: ${fmtDate(round.reveal_at)}（それまでは人数のみ表示）`}</div>`;
  }
  html += `</div>`;

  const notStarted = round.start_at && now < new Date(round.start_at);
  const ended = round.end_at && now > new Date(round.end_at);

  if (notStarted) {
    html += `<div class="notice info">このラウンドはまだ開始していません。開始をお待ちください。</div>`;
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

  let canEdit = false;
  let statusNotice = "";

  if (round.phase === "closed") {
    statusNotice = `<div class="notice info">このラウンドは終了しました。次のラウンドをお待ちください。</div>`;
  } else if (ended) {
    statusNotice = `<div class="notice info">受付終了時刻を過ぎました。抽選・確定処理をお待ちください。</div>`;
  } else if (attempt === 1) {
    if (!myPref || myPref.status === "submitted") {
      canEdit = true;
      if (myPref) statusNotice = `<div class="notice confirmed">${courseLabel}「${esc(myPref.slots.facility_name)} ${esc(myPref.slots.department_name)}」を希望として提出済みです。表をタップすると変更できます。</div>`;
    } else if (myPref.status === "confirmed") {
      statusNotice = `<div class="notice confirmed">${courseLabel}の希望は確定しました。次のラウンドをお待ちください。</div>`;
    } else if (myPref.status === "lost") {
      statusNotice = `<div class="notice warn">第一希望は抽選の結果、埋まってしまいました。事務局が2次マッチングを開始するまでお待ちください。</div>`;
    }
  } else {
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

  const remainingTermsIncludingThis = 6 - filledCourses.size;
  const forceNaika = remaining.internal_medicine > 0 && remaining.internal_medicine === remainingTermsIncludingThis;
  const forceGeka = remaining.surgery > 0 && remaining.surgery === remainingTermsIncludingThis;
  const forceInternal = remaining.internal > 0 && remaining.internal === remainingTermsIncludingThis;
  const forceExternal = remaining.external > 0 && remaining.external === remainingTermsIncludingThis;

  const forceMsgs = [];
  if (forceNaika) forceMsgs.push("内科系");
  if (forceGeka) forceMsgs.push("外科系");
  if (forceInternal) forceMsgs.push("院内");
  if (forceExternal) forceMsgs.push("院外");
  if (forceMsgs.length > 0) {
    html += `<div class="notice warn">残りターム数の都合上、今回は「${forceMsgs.join("・")}」の中から選ぶ必要があります(そうしないと院内3/院外3・内科3/外科3を満たせなくなります)。</div>`;
  }

  appEl.innerHTML = html;

  const { data: slots } = await sb.from("slots").select("*").eq("active", true);

  const { data: roundPrefs } = await sb
    .from("preferences")
    .select("slot_id, status, students(attendance_number, name)")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .in("status", ["submitted", "lottery", "confirmed"]);

  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, students(attendance_number, name)")
    .eq("course_number", courseNumber);

  const forceFlags = { forceNaika, forceGeka, forceInternal, forceExternal };
  const revealed = !round.reveal_at || now >= new Date(round.reveal_at);

  renderLegend(revealed);
  renderSingleGrid("internal", "院内", courseNumber, slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, remaining, forceFlags, revealed);
  renderSingleGrid("external", "院外", courseNumber, slots, roundPrefs || [], allAssignments || [], student, round, attempt, myPref, canEdit, remaining, forceFlags, revealed);
}

function renderLegend(revealed) {
  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="legend">
        <span><span class="sw" style="background:#fff2a8;border:1px solid #d8c463;"></span>内科系</span>
        <span><span class="sw" style="background:#b9e6b5;border:1px solid #7fc27a;"></span>外科系</span>
        <span><span class="sw" style="background:#f6dede;"></span>満員</span>
        <span><span class="sw" style="background:#dcdcdc;"></span>受入不可/対象者限定</span>
        <span><span class="sw" style="background:#d9f0e8;border:2px solid #2e7d6b;"></span>あなたの希望</span>
      </div>
      <p class="small-muted">${revealed
        ? "氏名は公開されています。太字は確定者、通常字は希望提出中の学生です。"
        : "現在は匿名期間中のため、他の人の希望は「人数」のみ表示され、氏名は分かりません。あなた自身の希望はいつでも確認できます。"}
        空いているセルをタップすると、その実習先を今回のタームの希望として提出できます。</p>
    </div>
  `);
}

function renderSingleGrid(institutionType, label, courseNumber, slots, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, remaining, forceFlags, revealed) {
  const list = slots
    .filter(s => s.institution_type === institutionType)
    .sort((a, b) => (a.facility_name + a.department_name).localeCompare(b.facility_name + b.department_name, "ja"));

  if (list.length === 0) return;

  let rows = "";
  for (const s of list) {
    const rowClass = s.category === "internal_medicine" ? "row-naika" : "row-geka";
    const cell = renderCell(s, courseNumber, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, remaining, forceFlags, revealed);
    rows += `<tr class="${rowClass}"><td class="dept-col"><b>${esc(s.facility_name)}</b><br/>${esc(s.department_name)}</td>${cell}</tr>`;
  }

  appEl.insertAdjacentHTML("beforeend", `
    <div class="card">
      <b>${label}の実習先</b>
      <div class="grid-scroll" style="margin-top:8px;">
        <table class="pref-grid">
          <thead><tr><th class="dept-col">実習先 / 診療科</th><th>${window.COURSE_LABELS[courseNumber-1]}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `);

  document.querySelectorAll(`td.cell-open[data-institution="${institutionType}"]`).forEach(td => {
    td.addEventListener("click", () => onCellClick(td, student, round, attempt, myPref));
  });
}

function renderCell(slot, courseNumber, roundPrefs, allAssignments, student, round, attempt, myPref, canEdit, remaining, forceFlags, revealed) {
  const cap = slot["cap_" + courseNumber];
  const isKuroshio = slot.department_name.includes("黒潮医療人養成プロジェクト") || slot.facility_name.includes("黒潮医療人養成プロジェクト");

  if (cap <= 0) {
    return `<td class="cell-slot cell-blocked">×</td>`;
  }
  if (isKuroshio) {
    return `<td class="cell-slot cell-blocked">対象者のみ</td>`;
  }

  const isMine = !!(myPref && myPref.slot_id === slot.id &&
    (myPref.status === "submitted" || myPref.status === "lottery"));

  const confirmedHere = allAssignments.filter(a => a.slot_id === slot.id);
  const pendingHere = roundPrefs.filter(p => p.slot_id === slot.id && p.status !== "confirmed");
  const totalCount = confirmedHere.length + pendingHere.length;
  const isFull = totalCount >= cap && !isMine;

  // 氏名表示ロジック：公開後はフルネーム、非公開中は自分だけ「あなた」と表示、他人数のみ
  let namesHtml = "";
  if (revealed) {
    namesHtml = [
      ...confirmedHere.map(a => `<b>${esc(a.students.name)}</b>`),
      ...pendingHere.map(p => `${esc(p.students.name)}${(myPref && p.slot_id===slot.id && p.student_id===student.id) ? "" : ""}`),
    ].join("、 ");
  } else {
    const others = totalCount - (isMine ? 1 : 0);
    const parts = [];
    if (isMine) parts.push(`<b>あなた</b>`);
    if (others > 0) parts.push(`他${others}名`);
    namesHtml = parts.join(" + ");
  }

  let eligible = canEdit && !isFull && (
    (slot.institution_type === "internal" && remaining.internal > 0) ||
    (slot.institution_type === "external" && remaining.external > 0)
  ) && (
    (slot.category === "internal_medicine" && remaining.internal_medicine > 0) ||
    (slot.category === "surgery" && remaining.surgery > 0)
  );

  if (eligible) {
    if (forceFlags.forceNaika && slot.category !== "internal_medicine") eligible = false;
    if (forceFlags.forceGeka && slot.category !== "surgery") eligible = false;
    if (forceFlags.forceInternal && slot.institution_type !== "internal") eligible = false;
    if (forceFlags.forceExternal && slot.institution_type !== "external") eligible = false;
  }

  let cls = "cell-slot";
  if (isMine) cls += " cell-mine";
  else if (isFull) cls += " cell-full";
  else if (eligible) cls += " cell-open";
  else cls += " cell-ineligible";

  const dataAttrs = eligible
    ? `data-slot="${slot.id}" data-institution="${slot.institution_type}" data-facility="${esc(slot.facility_name)}" data-dept="${esc(slot.department_name)}"`
    : "";

  return `<td class="${cls}" ${dataAttrs}>
    <div class="cell-cap">${totalCount}/${cap}</div>
    ${namesHtml ? `<div class="cell-names">${namesHtml}</div>` : ""}
  </td>`;
}

async function onCellClick(td, student, round, attempt, myPref) {
  const slotId = td.dataset.slot;
  const facility = td.dataset.facility;
  const dept = td.dataset.dept;
  const courseLabel = window.COURSE_LABELS[round.course_number - 1];

  const ok = confirm(`${courseLabel}「${facility} ${dept}」を希望として提出します。よろしいですか？`);
  if (!ok) return;

  td.style.opacity = "0.5";

  if (myPref) {
    const { error } = await sb.from("preferences")
      .update({ slot_id: slotId, course_number: round.course_number, status: "submitted" })
      .eq("id", myPref.id);
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  } else {
    const { error } = await sb.from("preferences").insert({
      student_id: student.id,
      round_id: round.id,
      slot_id: slotId,
      course_number: round.course_number,
      attempt: attempt,
      status: "submitted",
    });
    if (error) { alert("送信に失敗しました: " + error.message); td.style.opacity = "1"; return; }
  }
  location.reload();
}

main();
