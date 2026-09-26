const jsPsych = initJsPsych({
  show_progress_bar: TASK_MODE_CONFIG === "gjt_outside",
  auto_update_progress_bar: false,
  message_progress_bar: "課題の進捗"
});

const sessionId = jsPsych.randomization.randomID(12);
const sessionStartMs = performance.now();
const sessionStartIso = new Date().toISOString();
let gjtStartMs = null;
let gjtEndMs = null;
let questionnaireStartMs = null;
let leapQEndMs = null;
let exposureEndMs = null;

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isLikelyMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;
}

function deviceType() {
  if (/iPad|Tablet/i.test(navigator.userAgent)) return "tablet";
  if (isLikelyMobile()) return "mobile";
  return "desktop_or_laptop";
}

jsPsych.data.addProperties({
  session_id: sessionId,
  study: STUDY_NAME,
  jspsych_version: "8.2.3",
  session_start_iso: sessionStartIso,
  user_agent: navigator.userAgent,
  device_type: deviceType(),
  viewport_width: window.innerWidth,
  viewport_height: window.innerHeight,
  screen_width: window.screen.width,
  screen_height: window.screen.height,
  device_pixel_ratio: window.devicePixelRatio || 1,
  language: navigator.language || "",
  touch_points: navigator.maxTouchPoints || 0
});

const timeline = [];
const TASK_MODE = TASK_MODE_CONFIG;
const exposureStartMs = { value: null };
const version = "pilot2_split_2026-09-26_v1";
jsPsych.data.addProperties({ task_mode: TASK_MODE, experiment_version: version, stimulus_set_id: "pilot2_32_v1" });

// タブ移動・画面離脱をjsPsychのinteraction dataに記録。
jsPsych.data.addProperties({ interaction_recording_enabled: true });

timeline.push({
  type: jsPsychSurveyHtmlForm,
  preamble: `
    <div class="task-card compact-card">
      <h1>英語課題</h1>
      <p>担当者から指定された参加者番号を入力してください。</p>
    </div>`,
  html: `
    <div class="participant-form">
      <label for="participant_id"><strong>参加者番号</strong></label>
      <input id="participant_id" name="participant_id" type="text" required
             autocomplete="off" autocapitalize="none" spellcheck="false"
             pattern="[A-Za-z0-9_-]{1,30}" maxlength="30">
    </div>`,
  button_label: "次へ",
  data: { phase: "participant_info" },
  on_finish: data => {
    const pid = cleanText(data.response.participant_id);
    jsPsych.data.addProperties({
      participant_id: pid,
      assigned_input_device: TASK_MODE === "gjt_outside" ? "physical_keyboard" : "smartphone"
    });
  }
});

// スマホSafariではフルスクリーンの挙動が不安定なため、PC系のみ全画面を試す。
const fullscreenConditional = {
  timeline: [{
    type: jsPsychFullscreen,
    fullscreen_mode: true,
    message: `<div class="task-card compact-card"><p>「全画面で開始」を押してください。</p></div>`,
    button_label: "全画面で開始",
    data: { phase: "fullscreen_start" }
  }],
  conditional_function: () => !isLikelyMobile()
};
if (TASK_MODE === "gjt_outside") timeline.push(fullscreenConditional);

async function saveToDataPipe(csvText, filename) {
  const response = await fetch("https://pipe.jspsych.org/api/data/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      experimentID: DATAPIPE_EXPERIMENT_ID,
      filename,
      data: csvText
    })
  });
  let result = {};
  try { result = await response.json(); } catch (_) {}
  if (!response.ok || result.error || result.success === false) {
    throw new Error(result.message || `DataPipe returned HTTP ${response.status}`);
  }
  return { ...result, httpStatus: response.status };
}


function saveStage(stage, continueLabel) {
  const relevant = stage === "gjt" ? ["participant_info", "fullscreen_start", "gjt_instructions", "gjt_practice", "gjt_start", "gjt"] : ["participant_info", "outside_exposure_survey", "leapq_survey"];
  return {
    type: jsPsychHtmlButtonResponse,
    stimulus: `<div class="task-card save-message"><h2>${stage === "gjt" ? "GJT" : stage === "leapq" ? "英語学習経験アンケート" : "英語授業（３科目）以外の英語学習アンケート"}の回答を保存します</h2><p>保存完了まで画面を閉じないでください。</p><div id="save-status" role="status">保存中…</div><button id="retry-save" type="button" hidden>保存を再試行</button></div>`,
    choices: [continueLabel],
    data: { phase: `${stage}_save_status`, task_stage: stage },
    on_load: function() {
      const button = document.querySelector(".jspsych-btn");
      const status = document.getElementById("save-status");
      const retry = document.getElementById("retry-save");
      button.disabled = true;
      const pid = jsPsych.data.get().values().find(row => row.participant_id)?.participant_id || "unknown";
      const safePid = pid.replace(/[^A-Za-z0-9_-]/g, "_");
      const filename = `${STUDY_NAME}_${stage}_${safePid}_${sessionId}_${new Date().toISOString().replace(/[:.]/g,"-")}.csv`;
      const csvText = jsPsych.data.get().filterCustom(row => relevant.includes(row.phase)).csv();
      let fallbackDownloaded = false;
      async function attempt() {
        retry.hidden = true;
        status.textContent = "保存中…";
        try {
          if (!DATAPIPE_EXPERIMENT_ID.trim()) throw new Error("DataPipe Experiment ID is empty");
          const saveResult = await saveToDataPipe(csvText, filename);
          status.textContent = saveResult.httpStatus === 202
            ? "データはDataPipeに受け付けられ、保存先への送信待ちです。再送信せず、担当者が保存先を確認してください。"
            : "オンライン保存が完了しました。";
          button.disabled = false;
        } catch (error) {
          console.error("Save failed", error);
          if (ENABLE_LOCAL_CSV_FALLBACK && !fallbackDownloaded) {
            try {
              jsPsych.data.get().filterCustom(row => relevant.includes(row.phase)).localSave("csv", filename);
              fallbackDownloaded = true;
            } catch (downloadError) { console.error("Local save failed", downloadError); }
          }
          status.textContent = "オンライン保存に失敗しました。担当者に知らせ、再試行してください。";
          retry.hidden = false;
        }
      }
      retry.addEventListener("click", attempt);
      attempt();
    }
  };
}

timeline.push({type: jsPsychHtmlButtonResponse, stimulus: `<div class="task-card compact-card"><h2>英語学習経験アンケート</h2><p>英語学習経験について回答してください。</p></div>`, choices:["開始"], on_finish:()=>{questionnaireStartMs=performance.now();}});
// ---------- 短縮・改変版LEAP-Q ----------
timeline.push({
  type: jsPsychSurveyHtmlForm,
  preamble: `<div class="task-card compact-card">
    <div class="task-progress">英語学習経験アンケート</div>
    <h2>英語学習経験について</h2>
    <p>現在の状況について回答してください。</p>
  </div>`,
  html: `<div class="questionnaire-form">
    <label for="english_start_age"><strong>1．英語を学び始めた年齢</strong></label>
    <p class="question-help">学校、塾、英会話教室、家庭学習などを含めてください。</p>
    <div class="number-with-unit"><input id="english_start_age" name="english_start_age" type="number" min="0" max="30" step="1" required inputmode="numeric"><span>歳</span></div>

    <label for="formal_english_start_age"><strong>2．英語を継続的・本格的に学び始めた年齢</strong></label>
    <p class="question-help">学校の授業などで、継続して学び始めた年齢を答えてください。</p>
    <div class="number-with-unit"><input id="formal_english_start_age" name="formal_english_start_age" type="number" min="0" max="30" step="1" required inputmode="numeric"><span>歳</span></div>

    <label for="english_learning_years"><strong>3．これまでの英語学習年数</strong></label>
    <div class="number-with-unit"><input id="english_learning_years" name="english_learning_years" type="number" min="0" max="30" step="0.5" required inputmode="decimal"><span>年</span></div>

    <fieldset>
      <legend><strong>4．現在の英語力の自己評価</strong></legend>
      <p class="question-help">1＝ほとんどできない、6＝非常によくできる</p>
      <div class="rating-grid">
        <label for="self_reading">読む</label><select id="self_reading" name="self_reading" required>${["","1","2","3","4","5","6"].map(v => `<option value="${v}">${v || "選択"}</option>`).join("")}</select>
        <label for="self_listening">聞く</label><select id="self_listening" name="self_listening" required>${["","1","2","3","4","5","6"].map(v => `<option value="${v}">${v || "選択"}</option>`).join("")}</select>
        <label for="self_speaking">話す</label><select id="self_speaking" name="self_speaking" required>${["","1","2","3","4","5","6"].map(v => `<option value="${v}">${v || "選択"}</option>`).join("")}</select>
        <label for="self_writing">書く</label><select id="self_writing" name="self_writing" required>${["","1","2","3","4","5","6"].map(v => `<option value="${v}">${v || "選択"}</option>`).join("")}</select>
      </div>
    </fieldset>

    <label for="english_environment_months"><strong>5．英語が日常的に使われる国・地域での滞在経験</strong></label>
    <p class="question-help">経験がない場合は0を入力してください。旅行、留学、居住などを含めた合計期間です。</p>
    <div class="number-with-unit"><input id="english_environment_months" name="english_environment_months" type="number" min="0" max="600" step="0.5" required inputmode="decimal"><span>か月</span></div>

    <label for="er_total_words"><strong>6．現在までの多読総語数</strong></label>
    <p class="question-help">現在の多読記録にある累計語数を入力してください。まだ読んでいない場合は0を入力してください。</p>
    <div class="number-with-unit"><input id="er_total_words" name="er_total_words" type="number" min="0" step="1" required inputmode="numeric"><span>語</span></div>

    <label for="er_total_books"><strong>7．現在までの多読総冊数</strong></label>
    <p class="question-help">現在の多読記録にある累計冊数を入力してください。まだ読んでいない場合は0を入力してください。</p>
    <div class="number-with-unit"><input id="er_total_books" name="er_total_books" type="number" min="0" step="1" required inputmode="numeric"><span>冊</span></div>
  </div>`,
  button_label: "次へ",
  data: { phase: "leapq_survey", questionnaire_version: "short_adapted_v2_er_totals" },
  on_finish: data => {
    const r = data.response || {};
    data.english_start_age = Number(r.english_start_age);
    data.formal_english_start_age = Number(r.formal_english_start_age);
    data.english_learning_years = Number(r.english_learning_years);
    data.self_reading = Number(r.self_reading);
    data.self_listening = Number(r.self_listening);
    data.self_speaking = Number(r.self_speaking);
    data.self_writing = Number(r.self_writing);
    data.self_proficiency_mean = (data.self_reading + data.self_listening + data.self_speaking + data.self_writing) / 4;
    data.english_environment_months = Number(r.english_environment_months);
    data.er_total_words = Number(r.er_total_words);
    data.er_total_books = Number(r.er_total_books);
    data.age_consistency_flag = data.formal_english_start_age < data.english_start_age;
    delete data.response;
    leapQEndMs = performance.now();
    data.leapq_elapsed_ms = Math.round(leapQEndMs - questionnaireStartMs);
  }
});


timeline.push(saveStage("leapq", "終了"));
jsPsych.run(timeline);
