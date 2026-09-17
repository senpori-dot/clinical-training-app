// ============================================================
// 抽選の共通ロジック（学生ページ・管理画面の両方から呼び出す）
// ============================================================
// ラウンドは「第◯希望」というランク。学生は①〜⑥のうちまだ決まっていない
// クールの中から自由に(実習先, クール)の組を選んで希望を出す。
// 締切を過ぎたら、(実習先, クール)ごとに集計して定員超過分を抽選する。
window.tryRunLotteryIfDue = async function (sb, round) {
  if (!round) return round;
  const now = new Date();

  let phaseToProcess = null;
  if (round.phase === "first_choice" && round.end_at && now > new Date(round.end_at)) {
    phaseToProcess = "first_choice";
  } else if (round.phase === "second_match" && round.second_deadline && now > new Date(round.second_deadline)) {
    phaseToProcess = "second_match";
  } else if (round.phase === "third_match" && round.third_deadline && now > new Date(round.third_deadline)) {
    phaseToProcess = "third_match";
  }
  if (!phaseToProcess) return round;

  const lockPhase = phaseToProcess + "_processing";
  const { data: locked } = await sb
    .from("rounds")
    .update({ phase: lockPhase })
    .eq("id", round.id)
    .eq("phase", phaseToProcess)
    .select();

  if (!locked || locked.length === 0) {
    const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
    return fresh || round;
  }

  await window.runLotteryCore(sb, round, phaseToProcess);

  const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
  return fresh || round;
};

// 実際の抽選処理本体：(実習先, クール)ごと、かつ施設全体の人数上限も考慮したグローバル抽選
// ※ 他のラウンドで既に確定している人数もベースとして考慮し、定員を絶対に超えないようにする
window.runLotteryCore = async function (sb, round, phaseToProcess) {
  const attempt = phaseToProcess === "third_match" ? 3 : phaseToProcess === "second_match" ? 2 : 1;

  const { data: prefs, error: prefsErr } = await sb
    .from("preferences")
    .select("id, student_id, slot_id, course_number, status")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .eq("status", "submitted");
  if (prefsErr) console.error("preferences fetch error", prefsErr);

  const { data: facilityLimits } = await sb.from("facility_limits").select("*");
  const limitMap = {};
  (facilityLimits || []).forEach(f => { limitMap[f.facility_name] = f.max_total; });

  // slots情報はembed(join)を使わず、一度全件取得して自前でマップ化する
  // （環境によってはembed joinが失敗し、定員チェックが機能しなくなることがあったため）
  const { data: allSlots, error: slotsErr } = await sb
    .from("slots")
    .select("id, facility_name, cap_1, cap_2, cap_3, cap_4, cap_5, cap_6");
  if (slotsErr) console.error("slots fetch error", slotsErr);
  const slotMap = {};
  (allSlots || []).forEach(s => { slotMap[s.id] = s; });

  // 既に確定済み（他のラウンドを含む全体）の人数をベースラインとして読み込む
  const { data: existingAssignments, error: existingErr } = await sb
    .from("assignments")
    .select("slot_id, course_number");
  if (existingErr) console.error("assignments fetch error", existingErr);

  const slotCourseCount = {};
  const facilityCourseCount = {};
  for (const a of (existingAssignments || [])) {
    const slotKey = a.slot_id + "_" + a.course_number;
    slotCourseCount[slotKey] = (slotCourseCount[slotKey] || 0) + 1;
    const fname = slotMap[a.slot_id] && slotMap[a.slot_id].facility_name;
    if (fname) {
      const facKey = fname + "_" + a.course_number;
      facilityCourseCount[facKey] = (facilityCourseCount[facKey] || 0) + 1;
    }
  }

  const shuffled = (prefs || []).slice().sort(() => Math.random() - 0.5);
  let confirmedCount = 0, lostCount = 0;

  // 各(枠,クール)ごとの今回の希望者数を先に数えておく（抽選が発生したかどうかの判定に使う）
  const groupTotal = {};
  for (const p of shuffled) {
    const key = p.slot_id + "_" + p.course_number;
    groupTotal[key] = (groupTotal[key] || 0) + 1;
  }

  for (const p of shuffled) {
    const slot = slotMap[p.slot_id];
    if (!slot) { // 万一slot情報が取れなければ安全側に倒してlostにする
      await sb.from("preferences").update({ status: "lost" }).eq("id", p.id);
      lostCount++;
      continue;
    }
    const cap = slot["cap_" + p.course_number];
    const fname = slot.facility_name;
    const slotKey = p.slot_id + "_" + p.course_number;
    const facKey = fname + "_" + p.course_number;
    const curSlot = slotCourseCount[slotKey] || 0;
    const curFac = facilityCourseCount[facKey] || 0;
    const facLimit = limitMap[fname];
    const wasCompetitive = (groupTotal[slotKey] + curSlot) > cap;

    if (curSlot < cap && (!facLimit || curFac < facLimit)) {
      await sb.from("preferences").update({ status: "confirmed", won_lottery: wasCompetitive }).eq("id", p.id);
      await sb.from("assignments").upsert(
        { student_id: p.student_id, course_number: p.course_number, slot_id: p.slot_id },
        { onConflict: "student_id,course_number" }
      );
      slotCourseCount[slotKey] = curSlot + 1;
      facilityCourseCount[facKey] = curFac + 1;
      confirmedCount++;
    } else {
      await sb.from("preferences").update({ status: "lost", won_lottery: false }).eq("id", p.id);
      lostCount++;
    }
  }

  const nextPhase = phaseToProcess === "first_choice"
    ? (lostCount > 0 ? "second_match" : "closed")
    : "closed";

  await sb.from("rounds").update({ phase: nextPhase }).eq("id", round.id);

  // 南和歌山医療センター：宿泊施設の部屋割り（1人部屋2室＋4人部屋1室・同性のみ）の都合上、
  // 施設全体6名が「男女3:3」になると4人部屋を同性で埋められず部屋割りが破綻するため、
  // 今回のラウンドで新たに確定が発生した(施設,クール)についてのみ、3:3を避ける調整を行う。
  const touchedFacilityCourses = new Set();
  for (const p of shuffled) {
    const slot = slotMap[p.slot_id];
    if (slot && slot.facility_name.includes("南和歌山医療")) {
      touchedFacilityCourses.add(slot.facility_name + "_" + p.course_number);
    }
  }

  if (touchedFacilityCourses.size > 0) {
    const { data: genderStudents } = await sb.from("students").select("id, gender");
    const genderMap = {};
    (genderStudents || []).forEach(s => { genderMap[s.id] = s.gender; });

    for (const key of touchedFacilityCourses) {
      const lastUnderscoreIdx = key.lastIndexOf("_");
      const fname = key.slice(0, lastUnderscoreIdx);
      const courseNumber = Number(key.slice(lastUnderscoreIdx + 1));

      const { data: confirmedNow } = await sb
        .from("assignments")
        .select("id, student_id, slot_id")
        .eq("course_number", courseNumber)
        .in("slot_id", (allSlots || []).filter(s => s.facility_name === fname).map(s => s.id));

      const list = confirmedNow || [];
      if (list.length !== 6) continue; // 6名ちょうどの時だけ判定対象（部屋割りの前提が6名のため）

      const males = list.filter(a => genderMap[a.student_id] === "male");
      const females = list.filter(a => genderMap[a.student_id] === "female");
      if (males.length !== 3 || females.length !== 3) continue; // 3:3以外は問題なし

      // 3:3を崩すため、このラウンドで「lost」になった同施設・同クール希望者から
      // 逆側の性別の候補を探し、確定者1名と入れ替える
      const { data: lostCandidates } = await sb
        .from("preferences")
        .select("id, student_id, slot_id")
        .eq("round_id", round.id)
        .eq("attempt", attempt)
        .eq("course_number", courseNumber)
        .eq("status", "lost")
        .in("slot_id", (allSlots || []).filter(s => s.facility_name === fname).map(s => s.id));

      let swapped = false;
      for (const genderToAdd of ["female", "male"]) {
        const candidate = (lostCandidates || []).find(c => genderMap[c.student_id] === genderToAdd);
        if (!candidate) continue;
        const genderToRemove = genderToAdd === "female" ? "male" : "female";
        const removeTarget = list.find(a => genderMap[a.student_id] === genderToRemove);
        if (!removeTarget) continue;

        await sb.from("assignments").delete().eq("id", removeTarget.id);
        await sb.from("preferences")
          .update({ status: "lost", won_lottery: false })
          .eq("student_id", removeTarget.student_id)
          .eq("round_id", round.id)
          .eq("attempt", attempt);

        await sb.from("assignments").upsert(
          { student_id: candidate.student_id, course_number: courseNumber, slot_id: candidate.slot_id },
          { onConflict: "student_id,course_number" }
        );
        await sb.from("preferences")
          .update({ status: "confirmed", won_lottery: true })
          .eq("id", candidate.id);

        swapped = true;
        break;
      }
      if (!swapped) {
        console.warn("南和歌山医療センター: 3:3を回避できませんでした（代替候補なし）", fname, courseNumber);
      }
    }
  }

  return { confirmedCount, lostCount, nextPhase };
};
