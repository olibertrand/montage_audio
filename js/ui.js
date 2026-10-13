/* Interface : curseurs, menus, boîtes de dialogue, notifications, panneau du morceau sélectionné. */
(function (MA) {
  'use strict';
  const { U, Store, Clip } = MA;
  const icon = (n, s) => MA.icon(n, s);

  const UI = {};
  let overlays = null;

  UI.init = () => {
    overlays = document.getElementById('overlays');
  };

  /* ---------- Curseurs liés à l'état (avec annulation) ---------- */
  UI.bindSlider = (input, o) => {
    let active = false;
    const sync = () => {
      input.value = o.read();
      if (o.out) o.out();
    };
    input.addEventListener('input', () => {
      if (!active) {
        Store.checkpoint(o.label);
        active = true;
      }
      o.write(Number(input.value));
      if (o.out) o.out();
      Store.emit(o.kind, { live: true });
    });
    input.addEventListener('change', () => {
      active = false;
      Store.emit(o.kind);
    });
    input.addEventListener('dblclick', () => {
      Store.checkpoint(o.label);
      o.reset();
      sync();
      Store.emit(o.kind);
    });
    sync();
  };

  /* ---------- Bulle qui suit la souris pendant un glisser ---------- */
  let tipEl = null;
  UI.tip = (e, text) => {
    if (!e) {
      if (tipEl) tipEl.hidden = true;
      return;
    }
    if (!tipEl) {
      tipEl = U.el('div', { class: 'drag-tip', role: 'status' });
      document.body.append(tipEl);
    }
    tipEl.hidden = false;
    tipEl.textContent = text;
    const x = Math.min(window.innerWidth - tipEl.offsetWidth - 8, e.clientX + 14);
    tipEl.style.transform = `translate(${x}px, ${e.clientY + 18}px)`;
  };

  /* ---------- Notifications ---------- */
  UI.toast = (message, { action, kind = 'info', timeout } = {}) => {
    let box = document.getElementById('toasts');
    if (!box) {
      box = U.el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
      document.body.append(box);
    }
    const t = U.el('div', { class: `toast ${kind}` }, [U.el('span', { class: 'toast-text', text: message })]);
    const close = () => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 200);
    };
    if (action) {
      t.append(
        U.el('button', {
          class: 'btn small',
          type: 'button',
          text: action.label,
          onclick: () => {
            action.fn();
            close();
          },
        })
      );
    }
    t.append(U.el('button', { class: 'btn icon-only small toast-x', type: 'button', 'aria-label': 'Fermer', html: icon('x', 14), onclick: close }));
    box.append(t);
    // Pas plus de trois notifications à la fois : les plus anciennes s'effacent.
    const live = [...box.children].filter((n) => !n.classList.contains('leaving'));
    for (const old of live.slice(0, Math.max(0, live.length - 3))) old.remove();
    setTimeout(close, timeout || (kind === 'error' ? 9000 : action ? 6000 : 3500));
    return close;
  };

  /* ---------- Menus ---------- */
  let openMenu = null;

  UI.closeMenu = () => {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
      document.removeEventListener('pointerdown', outsideMenu, true);
    }
  };

  function outsideMenu(e) {
    if (openMenu && !openMenu.contains(e.target)) UI.closeMenu();
  }

  // items : [{label, icon, hint, disabled, checked, danger, action}] ou '-' (séparateur) ou {heading}
  UI.menu = (x, y, items, { anchor } = {}) => {
    UI.closeMenu();
    const menu = U.el('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (!it) continue;
      if (it === '-') {
        menu.append(U.el('div', { class: 'menu-sep', role: 'separator' }));
        continue;
      }
      if (it.heading) {
        menu.append(U.el('div', { class: 'menu-heading', text: it.heading }));
        continue;
      }
      if (it.swatches) {
        menu.append(it.swatches);
        continue;
      }
      const btn = U.el(
        'button',
        {
          class: 'menu-item' + (it.danger ? ' danger' : ''),
          type: 'button',
          role: it.checked != null ? 'menuitemcheckbox' : 'menuitem',
          'aria-checked': it.checked != null ? String(!!it.checked) : null,
          disabled: it.disabled || null,
        },
        [
          U.el('span', { class: 'menu-icon', html: it.checked ? icon('check', 16) : it.icon ? icon(it.icon, 16) : '' }),
          U.el('span', { class: 'menu-label', text: it.label }),
          it.hint ? U.el('kbd', { class: 'menu-hint', text: it.hint }) : null,
        ]
      );
      btn.addEventListener('click', () => {
        UI.closeMenu();
        it.action();
      });
      menu.append(btn);
    }
    overlays.append(menu);
    const r = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      left = a.right - r.width;
      top = a.bottom + 4;
      if (left < 8) left = a.left;
    }
    left = U.clamp(left, 8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, (anchor ? anchor.getBoundingClientRect().top : y) - r.height - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    openMenu = menu;
    setTimeout(() => document.addEventListener('pointerdown', outsideMenu, true), 0);
    const first = menu.querySelector('.menu-item:not([disabled])');
    if (first) first.focus({ preventScroll: true });
    menu.addEventListener('keydown', (e) => {
      const list = [...menu.querySelectorAll('.menu-item:not([disabled])')];
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[(i + 1) % list.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length].focus();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        UI.closeMenu();
      }
    });
    return menu;
  };

  UI.trackMenu = (trackId, anchor) => {
    const t = Store.track(trackId);
    if (!t) return;
    const idx = Store.trackIndex(trackId);
    const n = Store.state.tracks.length;
    const setDuck = (on, db) =>
      Store.transact(on ? 'Effacement automatique' : 'Retirer l’effacement automatique', () => {
        t.duck = on;
        if (db != null) t.duckDb = db;
      });
    const duckLevels = [
      { db: -6, label: 'Effacement léger (−6 dB)' },
      { db: -12, label: 'Effacement moyen (−12 dB)' },
      { db: -20, label: 'Effacement fort (−20 dB)' },
    ];
    UI.menu(0, 0, [
      { label: 'Renommer', icon: 'file', action: () => MA.App.focusTrackName(trackId) },
      '-',
      {
        label: 'S’effacer quand une autre piste joue',
        checked: !!t.duck,
        action: () => {
          setDuck(!t.duck);
          if (t.duck) UI.toast('La piste « ' + t.name + ' » baissera automatiquement quand une autre piste joue (pratique pour une musique sous une voix).');
        },
      },
      ...(t.duck ? duckLevels.map((l) => ({ label: l.label, checked: (t.duckDb == null ? -12 : t.duckDb) === l.db, action: () => setDuck(true, l.db) })) : []),
      '-',
      { label: 'Monter la piste', icon: 'up', disabled: idx === 0, action: () => MA.App.moveTrack(trackId, -1) },
      { label: 'Descendre la piste', icon: 'down', disabled: idx === n - 1, action: () => MA.App.moveTrack(trackId, 1) },
      { label: 'Dupliquer la piste', icon: 'copy', action: () => MA.App.duplicateTrack(trackId) },
      '-',
      { label: 'Supprimer la piste', icon: 'trash', danger: true, action: () => MA.App.deleteTrack(trackId) },
    ], { anchor });
  };

  UI.colorMenu = (trackId, anchor) => {
    const t = Store.track(trackId);
    const grid = U.el('div', { class: 'swatches' });
    for (const col of MA.TRACK_COLORS) {
      grid.append(
        U.el('button', {
          class: 'swatch' + (col === t.color ? ' current' : ''),
          type: 'button',
          style: { background: col },
          'aria-label': 'Couleur ' + col,
          onclick: () => {
            UI.closeMenu();
            Store.transact('Couleur de la piste', () => (t.color = col), 'meta');
          },
        })
      );
    }
    const m = UI.menu(0, 0, [{ heading: 'Couleur de la piste' }, { swatches: grid }], { anchor });
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(window.innerWidth - m.offsetWidth - 8, r.left) + 'px';
  };

  UI.clipMenu = (x, y, c) => {
    const ph = Store.playhead;
    const canSplit = Store.selectedClips().some((s) => ph > s.start && ph < Clip.end(s));
    const multi = Store.selection.size > 1;
    UI.menu(x, y, [
      { label: 'Couper à la tête de lecture', icon: 'scissors', hint: 'S', disabled: !canSplit, action: () => MA.App.split() },
      { label: 'Dupliquer', icon: 'copy', hint: U.modLabel + '+D', action: () => MA.App.duplicate() },
      { label: 'Copier', icon: 'copy', hint: U.modLabel + '+C', action: () => MA.App.copy() },
      '-',
      { label: multi ? 'Ajuster le volume de chaque morceau' : 'Ajuster le volume automatiquement', icon: 'wand', action: () => MA.App.normalize() },
      multi ? { label: 'Harmoniser les volumes entre eux', icon: 'levels', action: () => MA.App.matchLoudness() } : null,
      c.envelope && c.envelope.length ? { label: 'Effacer la courbe de volume', icon: 'curve', action: () => MA.App.clearEnvelope() } : null,
      c.fadeIn || c.fadeOut ? { label: 'Retirer les fondus', icon: 'x', action: () => MA.App.clearFades() } : null,
      '-',
      { label: 'Supprimer et rapprocher la suite', icon: 'trash', action: () => MA.App.deleteSelection({ ripple: true }) },
      { label: 'Supprimer', icon: 'trash', danger: true, hint: 'Suppr', action: () => MA.App.deleteSelection() },
    ]);
  };

  UI.laneMenu = (x, y, trackId, t) => {
    UI.menu(x, y, [
      { label: 'Placer la tête de lecture ici', icon: 'cursor', action: () => MA.App.seek(t) },
      { label: 'Coller ici', icon: 'copy', hint: U.modLabel + '+V', disabled: !Store.clipboard, action: () => MA.App.paste(trackId, t) },
      { label: 'Importer des sons ici…', icon: 'import', action: () => MA.App.openImport({ trackId, time: t }) },
    ]);
  };

  /* ---------- Boîtes de dialogue ---------- */
  let dialogStack = [];

  // canClose : fonction facultative ; renvoie false pour empêcher la fermeture (travail en cours).
  UI.dialog = ({ title, body, buttons = [], wide = false, onClose, canClose }) => {
    const prevFocus = document.activeElement;
    const back = U.el('div', { class: 'dialog-back' });
    const box = U.el('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const close = (force) => {
      if (force !== true && canClose && !canClose()) return;
      back.remove();
      dialogStack = dialogStack.filter((d) => d !== api);
      if (onClose) onClose();
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    };
    const head = U.el('div', { class: 'dialog-head' }, [
      U.el('h2', { text: title }),
      U.el('button', { class: 'btn icon-only', type: 'button', 'aria-label': 'Fermer', html: icon('x'), onclick: close }),
    ]);
    const content = U.el('div', { class: 'dialog-body' }, [body]);
    const foot = U.el('div', { class: 'dialog-foot' });
    for (const b of buttons) {
      const btn = U.el('button', { class: 'btn ' + (b.kind || ''), type: 'button', html: (b.icon ? icon(b.icon) : '') + '<span></span>' });
      btn.lastChild.textContent = b.label;
      btn.addEventListener('click', async () => {
        if (!b.action) return close();
        const keep = await b.action(btn);
        if (keep !== false) close(true);
      });
      foot.append(btn);
      b.el = btn;
    }
    box.append(head, content);
    if (buttons.length) box.append(foot);
    back.append(box);
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) close();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    overlays.append(back);
    const api = { close, el: box, buttons };
    dialogStack.push(api);
    const focusable = box.querySelector('.dialog-body input, .dialog-body select, .dialog-foot .primary, .dialog-foot .accent, .dialog-foot .btn');
    (focusable || box).focus({ preventScroll: true });
    return api;
  };

  UI.dialogOpen = () => dialogStack.length > 0 || !!openMenu;

  UI.confirm = (title, text, okLabel = 'Confirmer', danger = false) =>
    new Promise((resolve) => {
      let answered = false;
      UI.dialog({
        title,
        body: U.el('p', { class: 'dialog-text', text }),
        buttons: [
          { label: 'Annuler', kind: 'ghost', action: () => { answered = true; resolve(false); } },
          { label: okLabel, kind: danger ? 'danger' : 'primary', action: () => { answered = true; resolve(true); } },
        ],
        onClose: () => {
          if (!answered) resolve(false);
        },
      });
    });

  /* ---------- Panneau du morceau sélectionné ---------- */
  let inspKey = null;
  let inspRefresh = null;

  UI.renderInspector = () => {
    const el = document.getElementById('inspector');
    if (!Store.state) return;
    const sel = Store.selectedClips();
    const key = sel.length === 1 ? 'one:' + sel[0].id : sel.length > 1 ? 'many:' + sel.map((c) => c.id).join(',') : 'none';
    if (key === inspKey && inspRefresh) {
      inspRefresh();
      return;
    }
    inspKey = key;
    el.textContent = '';
    if (sel.length === 1) inspRefresh = buildClipInspector(el, sel[0].id);
    else if (sel.length > 1) inspRefresh = buildMultiInspector(el, sel.length);
    else inspRefresh = buildIdleInspector(el);
    inspRefresh();
  };

  function field(label, control, extra) {
    return U.el('div', { class: 'insp-field' }, [U.el('div', { class: 'insp-label' }, [label]), control, extra || null]);
  }

  function actionButton(label, ic, fn, cls = '') {
    return U.el('button', { class: 'btn small ' + cls, type: 'button', html: icon(ic, 16) + `<span>${label}</span>`, onclick: fn });
  }

  function buildClipInspector(root, clipId) {
    const clip = () => Store.clip(clipId);
    const c0 = clip();
    const swatch = U.el('span', { class: 'insp-swatch' });
    const name = U.el('input', { class: 'insp-name', id: 'insp-name', type: 'text', 'aria-label': 'Nom du morceau', spellcheck: 'false' });
    name.value = c0.name;
    name.addEventListener('change', () => {
      const v = name.value.trim() || 'Morceau';
      if (v !== clip().name) Store.transact('Renommer le morceau', () => (clip().name = v), 'meta');
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') name.blur();
    });
    const meta = U.el('span', { class: 'insp-meta' });

    const gain = U.el('input', { type: 'range', id: 'insp-gain', min: -24, max: 24, step: 0.5, 'aria-label': 'Volume du morceau' });
    const gainOut = U.el('output', { for: 'insp-gain', class: 'insp-val' });
    UI.bindSlider(gain, {
      label: 'Volume du morceau',
      read: () => clip().gain || 0,
      write: (v) => (clip().gain = v),
      reset: () => (clip().gain = 0),
      kind: 'clips',
      out: () => (gainOut.textContent = U.formatDb(clip().gain || 0)),
    });

    const mkFade = (key, label) => {
      const input = U.el('input', { type: 'range', id: 'insp-' + key, min: 0, max: 10, step: 0.1, 'aria-label': label });
      const out = U.el('output', { for: 'insp-' + key, class: 'insp-val' });
      UI.bindSlider(input, {
        label,
        read: () => clip()[key] || 0,
        write: (v) => {
          const c = clip();
          const other = key === 'fadeIn' ? c.fadeOut || 0 : c.fadeIn || 0;
          c[key] = Math.min(v, Math.max(0, c.duration - other));
        },
        reset: () => (clip()[key] = 0),
        kind: 'clips',
        out: () => (out.textContent = clip()[key] ? U.formatSeconds(clip()[key]) : 'aucun'),
      });
      return { input, out };
    };
    const fin = mkFade('fadeIn', 'Fondu d’entrée');
    const fout = mkFade('fadeOut', 'Fondu de sortie');

    const envInfo = U.el('span', { class: 'insp-env-info' });
    const envClear = actionButton('Effacer', 'x', () => MA.App.clearEnvelope());

    root.append(
      U.el('div', { class: 'insp-head' }, [swatch, name, meta]),
      U.el('div', { class: 'insp-grid' }, [
        field('Volume du morceau', U.el('div', { class: 'insp-row' }, [gain, gainOut]), actionButton('Ajuster automatiquement', 'wand', () => MA.App.normalize())),
        field('Fondu d’entrée', U.el('div', { class: 'insp-row' }, [fin.input, fin.out])),
        field('Fondu de sortie', U.el('div', { class: 'insp-row' }, [fout.input, fout.out])),
        field(
          'Courbe de volume',
          U.el('p', { class: 'insp-hint', text: 'Cliquez sur la ligne du morceau pour ajouter un point, puis faites-le glisser. Double-clic sur un point pour le retirer.' }),
          U.el('div', { class: 'insp-row' }, [envInfo, envClear])
        ),
        U.el('div', { class: 'insp-actions' }, [
          actionButton('Couper ici', 'scissors', () => MA.App.split()),
          actionButton('Dupliquer', 'copy', () => MA.App.duplicate()),
          actionButton('Supprimer', 'trash', () => MA.App.deleteSelection(), 'danger-text'),
        ]),
      ])
    );

    return () => {
      const c = clip();
      if (!c) return;
      const tr = Store.track(c.trackId);
      swatch.style.background = tr ? tr.color : '#888';
      if (document.activeElement !== name) name.value = c.name;
      const src = Store.source(c.sourceId);
      meta.textContent = `Début ${U.formatTime(c.start)} · Durée ${U.formatSeconds(c.duration)}` + (src ? ` · Fichier : ${src.name}` : '');
      const maxFade = Math.max(0.1, Math.min(30, c.duration));
      for (const f of [fin, fout]) {
        f.input.max = maxFade;
        f.input.step = maxFade > 5 ? 0.1 : 0.05;
      }
      if (!gain.matches(':active')) gain.value = c.gain || 0;
      if (!fin.input.matches(':active')) fin.input.value = c.fadeIn || 0;
      if (!fout.input.matches(':active')) fout.input.value = c.fadeOut || 0;
      gainOut.textContent = U.formatDb(c.gain || 0);
      fin.out.textContent = c.fadeIn ? U.formatSeconds(c.fadeIn) : 'aucun';
      fout.out.textContent = c.fadeOut ? U.formatSeconds(c.fadeOut) : 'aucun';
      const n = (c.envelope || []).length;
      envInfo.textContent = n ? `${n} point${n > 1 ? 's' : ''}` : 'Aucun point';
      envClear.disabled = !n;
    };
  }

  function buildMultiInspector(root, count) {
    const title = U.el('strong', { class: 'insp-title' });
    root.append(
      U.el('div', { class: 'insp-head' }, [title, U.el('span', { class: 'insp-meta', text: 'Faites glisser l’un d’eux pour tous les déplacer.' })]),
      U.el('div', { class: 'insp-actions wide' }, [
        actionButton('Ajuster le volume de chacun', 'wand', () => MA.App.normalize()),
        actionButton('Harmoniser les volumes entre eux', 'levels', () => MA.App.matchLoudness()),
        actionButton('Couper ici', 'scissors', () => MA.App.split()),
        actionButton('Dupliquer', 'copy', () => MA.App.duplicate()),
        actionButton('Supprimer', 'trash', () => MA.App.deleteSelection(), 'danger-text'),
      ])
    );
    return () => {
      title.textContent = `${Store.selection.size || count} morceaux sélectionnés`;
    };
  }

  function buildIdleInspector(root) {
    const stats = U.el('span', { class: 'insp-meta' });
    const tips = [
      'Cliquez sur un morceau pour régler son volume, ses fondus ou le couper.',
      'Tirez le petit rond en haut à gauche ou à droite d’un morceau pour créer un fondu.',
      'Placez la tête de lecture, puis appuyez sur S pour couper le morceau sélectionné.',
      'Le curseur Volume de chaque piste règle son niveau dans le mélange.',
      `Tracez un cadre autour de plusieurs morceaux pour les sélectionner ensemble.`,
    ];
    root.append(
      U.el('div', { class: 'insp-head' }, [U.el('strong', { class: 'insp-title', text: 'Aucun morceau sélectionné' }), stats]),
      U.el('ul', { class: 'insp-tips' }, tips.map((t) => U.el('li', { text: t })))
    );
    return () => {
      const nT = Store.state.tracks.length;
      const nC = Store.state.clips.length;
      stats.textContent = `Durée totale ${U.formatTime(Store.projectEnd())} · ${nT} piste${nT > 1 ? 's' : ''} · ${nC} morceau${nC > 1 ? 'x' : ''}`;
    };
  }

  /* ---------- Aide ---------- */
  UI.showHelp = () => {
    const m = U.modLabel;
    const shortcuts = [
      ['Espace', 'Lecture / pause'],
      ['Début', 'Revenir au début du montage'],
      ['← →', 'Avancer ou reculer d’une seconde (Maj : 5 s)'],
      ['S', 'Couper à la tête de lecture'],
      ['Suppr', 'Supprimer les morceaux sélectionnés'],
      [`${m}+Z`, 'Annuler'],
      [`${m}+Maj+Z`, 'Rétablir'],
      [`${m}+C / ${m}+V`, 'Copier / coller à la tête de lecture'],
      [`${m}+D`, 'Dupliquer'],
      [`${m}+A`, 'Tout sélectionner'],
      ['+ / −', 'Zoomer / dézoomer'],
      [`${m}+molette`, 'Zoomer à l’endroit de la souris'],
      ['Alt pendant un glisser', 'Désactiver l’aimant'],
      ['R', 'Enregistrer au micro'],
      [`${m}+S`, 'Enregistrer le projet'],
    ];
    const steps = [
      ['Importez vos sons', 'Bouton « Importer des sons » ou glissez vos fichiers (MP3, WAV, M4A, OGG, FLAC…) dans la fenêtre. Chaque fichier arrive sur sa propre piste.'],
      ['Placez-les dans le temps', 'Attrapez un morceau et faites-le glisser vers la gauche ou la droite, ou vers une autre piste. Tirez son bord gauche ou droit pour le raccourcir.'],
      ['Réglez les niveaux', 'Chaque piste a son curseur Volume et sa Balance. « Muet » coupe une piste, « Solo » n’écoute qu’elle. Le volume d’un seul morceau se règle dans le panneau du bas.'],
      ['Adoucissez les transitions', 'Tirez le petit rond en haut d’un morceau pour un fondu. Pour baisser le son à un endroit précis, sélectionnez le morceau et cliquez sur sa ligne de volume pour ajouter des points.'],
      ['Exportez', 'Le bouton « Exporter » crée un fichier MP3 (léger, pour partager) ou WAV (qualité maximale) avec toutes les pistes mélangées.'],
    ];
    const words = [
      ['Piste', 'Une ligne horizontale. Toutes les pistes sont jouées en même temps et mélangées.'],
      ['Morceau', 'Un extrait de son posé sur une piste. Un même fichier peut donner plusieurs morceaux.'],
      ['dB (décibel)', 'Unité de volume. 0 dB = volume d’origine ; −6 dB ≈ deux fois moins fort ; +6 dB ≈ deux fois plus fort.'],
      ['Fondu', 'Montée ou descente progressive du volume au début ou à la fin d’un morceau.'],
      ['S’effacer', 'Option d’une piste (menu ⋯) : elle baisse toute seule quand une autre piste joue. Idéal pour une musique de fond sous une voix.'],
      ['Saturation', 'Quand le son est trop fort, il grésille. Si le témoin rouge s’allume, baissez un peu les volumes.'],
    ];
    const body = U.el('div', { class: 'help' }, [
      U.el('section', {}, [
        U.el('h3', { text: 'Les bases en 5 étapes' }),
        U.el('ol', { class: 'help-steps' }, steps.map(([t, d]) => U.el('li', {}, [U.el('strong', { text: t }), U.el('span', { text: d })]))),
      ]),
      U.el('section', {}, [
        U.el('h3', { text: 'Raccourcis clavier' }),
        U.el('table', { class: 'help-keys' }, [U.el('tbody', {}, shortcuts.map(([k, d]) => U.el('tr', {}, [U.el('td', {}, [U.el('kbd', { text: k })]), U.el('td', { text: d })])))]),
      ]),
      U.el('section', {}, [
        U.el('h3', { text: 'Petit lexique' }),
        U.el('dl', { class: 'help-words' }, words.flatMap(([w, d]) => [U.el('dt', { text: w }), U.el('dd', { text: d })])),
      ]),
      U.el('section', {}, [
        U.el('h3', { text: 'Où est enregistré mon travail ?' }),
        U.el('p', {
          text:
            'Le montage est gardé automatiquement dans ce navigateur, sur cet ordinateur : vous le retrouvez en rouvrant la page. Pour le conserver ailleurs ou le transmettre, utilisez « Enregistrer » : vous obtenez un fichier projet qui contient aussi vos sons, à rouvrir avec « Ouvrir ». Vos fichiers ne sont envoyés nulle part.',
        }),
      ]),
    ]);
    UI.dialog({ title: 'Aide', body, wide: true, buttons: [{ label: 'Compris', kind: 'primary' }] });
  };

  MA.UI = UI;
})((window.MA = window.MA || {}));
