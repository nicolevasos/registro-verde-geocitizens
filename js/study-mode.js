(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const enabled = params.get('study') === '1' || params.has('participant');
  if (!enabled) return;

  const participant = params.get('participant') || 'anonymous';
  const condition = params.get('condition') || 'multi_candidate';
  const state = {
    config: null,
    currentTask: 0,
    completed: new Set(),
    consented: false,
    finished: false
  };
  const key = `geocitizens_study_progress_${participant}_${condition}`;

  function el(id) {
    return document.getElementById(id);
  }

  function apiCandidates(path) {
    const candidates = [path];
    if (location.protocol === 'http:' && !['5050', '8000'].includes(location.port)) {
      candidates.push(
        `http://127.0.0.1:5050${path}`,
        `http://localhost:5050${path}`
      );
    }
    return candidates;
  }

  async function api(path, options = {}) {
    let lastError;
    for (const url of apiCandidates(path)) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Study backend unavailable');
  }

  function save() {
    localStorage.setItem(key, JSON.stringify({
      currentTask: state.currentTask,
      completed: [...state.completed],
      consented: state.consented,
      finished: state.finished
    }));
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      state.currentTask = saved.currentTask || 0;
      state.completed = new Set(saved.completed || []);
      state.consented = Boolean(saved.consented);
      state.finished = Boolean(saved.finished);
    } catch (_) {
      // Ignore invalid saved state.
    }
  }

  function log(type, payload = {}) {
    if (typeof window.logStudyEvent === 'function') {
      window.logStudyEvent(type, payload, null, payload.task_id || null);
    }
  }

  function resetStudyScroll() {
    const card = document.querySelector('#study-shell .study-card');
    const questionnaireScroller = document.querySelector('.study-questionnaire-scroll');
    const activePanel = document.querySelector('#study-shell .study-panel:not([hidden])');

    [card, questionnaireScroller, activePanel].forEach(node => {
      if (!node) return;
      node.scrollTop = 0;
      node.scrollLeft = 0;
    });
  }

  function show(name) {
    const shell = el('study-shell');
    const targetPanel = el(name);

    if (!shell || !targetPanel) {
      console.error('Study panel could not be displayed:', name);
      return;
    }

    shell.querySelectorAll('.study-panel').forEach(panel => {
      panel.hidden = true;
    });

    targetPanel.hidden = false;
    shell.classList.add('open');

    requestAnimationFrame(() => {
      resetStudyScroll();
    });
  }

  function closeShell() {
    el('study-shell')?.classList.remove('open');
  }

  function renderTask() {
    const tasks = state.config?.tasks || [];
    const task = tasks[state.currentTask];

    if (!task) {
      showQuestionnaire();
      return;
    }

    el('study-task-index').textContent = `Task ${state.currentTask + 1} of ${tasks.length}`;
    el('study-task-title').textContent = task.title;
    el('study-task-instruction').textContent = task.instruction;
    el('study-progress-fill').style.width = `${Math.round(state.completed.size / tasks.length * 100)}%`;
    el('study-task-status').textContent = state.completed.has(task.id)
      ? 'Completed ✓'
      : 'Waiting for the required action…';
    el('study-next-task').disabled = !state.completed.has(task.id);
    show('study-task-panel');
  }

  function eventMatches(task, eventType, payload) {
    if (task.completion_event !== eventType) return false;
    const match = task.completion_match || {};
    return Object.entries(match).every(([field, value]) => payload && payload[field] === value);
  }

  function markFromEvent(eventType, payload) {
    const tasks = state.config?.tasks || [];
    const task = tasks[state.currentTask];
    if (!task || !eventMatches(task, eventType, payload)) return;

    state.completed.add(task.id);
    save();
    renderTask();
    log('study_task_completed', {
      task_id: task.id,
      task_index: state.currentTask
    });
  }

  function wrapLogger() {
    const original = window.logStudyEvent;
    if (typeof original !== 'function') {
      setTimeout(wrapLogger, 100);
      return;
    }
    if (original.__studyWrapped) return;

    async function wrapped(eventType, payload = {}, plotName = null, taskId = null, elapsedMs = null) {
      const result = await original(eventType, payload, plotName, taskId, elapsedMs);
      markFromEvent(eventType, payload || {});
      return result;
    }

    wrapped.__studyWrapped = true;
    window.logStudyEvent = wrapped;
  }

  function buildLikert(name, label, count = 5) {
    const options = Array.from({ length: count }, (_, index) => {
      const value = index + 1;
      return `<label><input type="radio" name="${name}" value="${value}"><span>${value}</span></label>`;
    }).join('');

    return `<fieldset class="study-question" data-question-name="${name}"><legend>${label}</legend><div class="study-likert">${options}</div></fieldset>`;
  }

  function showQuestionnaire() {
    const sus = [
      'I think that I would like to use this system frequently.',
      'I found the system unnecessarily complex.',
      'I thought the system was easy to use.',
      'I think that I would need support to use this system.',
      'I found the functions in this system well integrated.',
      'I thought there was too much inconsistency in this system.',
      'I imagine that most people would learn to use this system quickly.',
      'I found the system cumbersome to use.',
      'I felt confident using the system.',
      'I needed to learn many things before I could use this system.'
    ];

    const tlx = [
      ['mental', 'Mental demand'],
      ['physical', 'Physical demand'],
      ['temporal', 'Temporal demand'],
      ['performance', 'Effort to achieve good performance'],
      ['effort', 'Overall effort'],
      ['frustration', 'Frustration']
    ];

    const fields = el('study-questionnaire-fields');
    if (!fields) return;

    fields.innerHTML = `
      <h3>System Usability Scale</h3>
      ${sus.map((question, index) => buildLikert(`sus_${index + 1}`, question)).join('')}
      <h3>Workload</h3>
      ${tlx.map(([name, label]) => buildLikert(`tlx_${name}`, label, 7)).join('')}
      <h3>GeoCitizens experience</h3>
      ${buildLikert('custom_understood', 'I understood why the system suggested its repair.')}
      ${buildLikert('custom_control', 'The repair alternatives gave me enough control.')}
      ${buildLikert('custom_use', 'I would use this workflow in practice.')}
      <label class="study-text-label">Additional comments<textarea name="comments" rows="4" placeholder="Optional"></textarea></label>
    `;

    el('study-questionnaire-error').textContent = '';
    show('study-questionnaire-panel');
  }

  function formObject(form) {
    const output = {};
    new FormData(form).forEach((value, field) => {
      output[field] = value;
    });
    return output;
  }

  function requiredQuestionNames() {
    return [
      ...Array.from({ length: 10 }, (_, index) => `sus_${index + 1}`),
      'tlx_mental',
      'tlx_physical',
      'tlx_temporal',
      'tlx_performance',
      'tlx_effort',
      'tlx_frustration',
      'custom_understood',
      'custom_control',
      'custom_use'
    ];
  }

  function validateQuestionnaire(form) {
    form.querySelectorAll('.study-question.missing').forEach(question => {
      question.classList.remove('missing');
    });

    const missing = requiredQuestionNames().filter(name => {
      return !form.querySelector(`input[name="${name}"]:checked`);
    });

    if (!missing.length) return true;

    missing.forEach(name => {
      form.querySelector(`[data-question-name="${name}"]`)?.classList.add('missing');
    });

    const firstMissing = form.querySelector(`[data-question-name="${missing[0]}"]`);
    const scroller = form.querySelector('.study-questionnaire-scroll');
    const error = el('study-questionnaire-error');

    if (error) {
      error.textContent = `Please answer all numbered items. ${missing.length} response${missing.length === 1 ? '' : 's'} remaining.`;
    }

    if (firstMissing && scroller) {
      const top = firstMissing.offsetTop - 12;
      scroller.scrollTo({ top, behavior: 'smooth' });
      firstMissing.querySelector('input')?.focus({ preventScroll: true });
    }

    return false;
  }

  function susScore(responses) {
    let total = 0;
    for (let index = 1; index <= 10; index += 1) {
      const value = Number(responses[`sus_${index}`]);
      total += index % 2 === 1 ? value - 1 : 5 - value;
    }
    return total * 2.5;
  }

  async function submitQuestionnaire(event) {
    event.preventDefault();

    const form = event.currentTarget;
    if (!validateQuestionnaire(form)) return;

    const responses = formObject(form);
    responses.sus_score = susScore(responses);

    const body = {
      session_uuid: sessionStorage.getItem('geocitizens_study_session'),
      questionnaire_type: 'post_study',
      responses
    };

    const submitButton = form.querySelector('button[type="submit"]');
    const error = el('study-questionnaire-error');

    try {
      if (error) error.textContent = '';
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Saving…';
      }

      const result = await api('/api/study/questionnaires', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      // The backend completes the same session atomically when the post-study
      // questionnaire is stored. Mark it locally as well so pagehide does not
      // overwrite the completed status with left_page.
      sessionStorage.setItem(
        'geocitizens_study_completed_session',
        body.session_uuid
      );

      state.finished = true;
      save();
      log('study_completed', {
        sus_score: responses.sus_score,
        tasks_completed: state.completed.size,
        completion_status: result.completion_status || 'completed'
      });
      show('study-finish-panel');
    } catch (requestError) {
      if (error) error.textContent = `Could not save: ${requestError.message}`;
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit and finish';
      }
    }
  }

  async function init() {
    restore();

    try {
      state.config = await api(`/api/study/config?condition=${encodeURIComponent(condition)}`);
    } catch (_) {
      state.config = {
        study_title: 'GeoCitizens study',
        estimated_minutes: 20,
        consent_points: ['Participation is voluntary.'],
        tasks: []
      };
    }

    el('study-title').textContent = state.config.study_title;
    el('study-subtitle').textContent = `Participant ${participant} · ${state.config.condition_label || condition} · about ${state.config.estimated_minutes || 20} minutes`;
    el('study-consent-list').innerHTML = (state.config.consent_points || []).map(point => `<li>${point}</li>`).join('');
    el('study-badge').textContent = `Study · ${participant}`;
    el('study-badge').hidden = false;

    wrapLogger();

    if (state.finished) show('study-finish-panel');
    else if (!state.consented) show('study-consent-panel');
    else renderTask();
  }

  document.addEventListener('DOMContentLoaded', () => {
    el('study-consent-btn')?.addEventListener('click', () => {
      if (!el('study-consent-check')?.checked) return;
      state.consented = true;
      save();
      log('consent_given', { participant, condition });
      renderTask();
    });

    el('study-decline-btn')?.addEventListener('click', () => {
      log('consent_declined', { participant, condition });
      el('study-consent-note').textContent = 'You may close this page. No study tasks will begin.';
    });

    el('study-next-task')?.addEventListener('click', () => {
      state.currentTask += 1;
      save();
      renderTask();
    });

    el('study-minimize')?.addEventListener('click', closeShell);

    el('study-badge')?.addEventListener('click', () => {
      if (state.finished) show('study-finish-panel');
      else if (state.consented) renderTask();
      else show('study-consent-panel');
    });

    const questionnaireForm = el('study-questionnaire-form');
    questionnaireForm?.addEventListener('submit', submitQuestionnaire);
    questionnaireForm?.addEventListener('change', event => {
      if (!event.target.matches('input[type="radio"]')) return;
      event.target.closest('.study-question')?.classList.remove('missing');
      const error = el('study-questionnaire-error');
      if (error && !questionnaireForm.querySelector('.study-question.missing')) {
        error.textContent = '';
      }
    });

    init();
  });
})();
