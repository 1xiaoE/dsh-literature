/** Scoped Harness Literature workbench styles, injected by the client bundle. */
export const CSS = {
  view: 'dsh-lit-view', entry: 'dsh-lit-entry', entryIcon: 'dsh-lit-entry-icon', entryLabel: 'dsh-lit-entry-label',
  workbench: 'dsh-lit-workbench', header: 'dsh-lit-header', headerActions: 'dsh-lit-header-actions', title: 'dsh-lit-title',
  badge: 'dsh-lit-badge', badgeLive: 'dsh-lit-badge-live', badgeDemo: 'dsh-lit-badge-demo', badgeUnavailable: 'dsh-lit-badge-unavailable',
  grid: 'dsh-lit-grid', panel: 'dsh-lit-panel', panelTitle: 'dsh-lit-panel-title', topRow: 'dsh-lit-top-row', bottomRow: 'dsh-lit-bottom-row',
  execution: 'dsh-lit-execution', executionWarning: 'dsh-lit-execution-warning', search: 'dsh-lit-search', categories: 'dsh-lit-categories', papers: 'dsh-lit-papers', details: 'dsh-lit-details',
  statusBadge: 'dsh-lit-status-badge', statusRunning: 'dsh-lit-status-running', statusOk: 'dsh-lit-status-ok', statusWarn: 'dsh-lit-status-warn', statusErr: 'dsh-lit-status-err',
  workflowProgress: 'dsh-lit-workflow-progress', workflowStage: 'dsh-lit-workflow-stage', workflowMarker: 'dsh-lit-workflow-marker', workflowLogs: 'dsh-lit-workflow-logs',
  stepList: 'dsh-lit-step-list', step: 'dsh-lit-step', stepDone: 'dsh-lit-step-done', stepActive: 'dsh-lit-step-active', stepMuted: 'dsh-lit-step-muted', stepText: 'dsh-lit-step-text', spinner: 'dsh-lit-spinner',
  authCard: 'dsh-lit-auth-card', authTitle: 'dsh-lit-auth-title', authGrid: 'dsh-lit-auth-grid', authLabel: 'dsh-lit-auth-label', authValue: 'dsh-lit-auth-value',
  button: 'dsh-lit-button', buttonPrimary: 'dsh-lit-button-primary', buttonGhost: 'dsh-lit-button-ghost', input: 'dsh-lit-input',
  searchRow: 'dsh-lit-search-row', searchModes: 'dsh-lit-search-modes', searchMode: 'dsh-lit-search-mode', searchModeActive: 'dsh-lit-search-mode-active', searchMessage: 'dsh-lit-search-message', runnerLog: 'dsh-lit-runner-log',
  paperCard: 'dsh-lit-paper-card', paperCardActive: 'dsh-lit-paper-card-active', paperTitle: 'dsh-lit-paper-title', paperMeta: 'dsh-lit-paper-meta', paperFlags: 'dsh-lit-paper-flags', flag: 'dsh-lit-flag', checkbox: 'dsh-lit-checkbox',
  categoryItem: 'dsh-lit-category-item', categoryItemActive: 'dsh-lit-category-item-active', categoryGroup: 'dsh-lit-category-group', categorySummary: 'dsh-lit-category-summary', categoryBody: 'dsh-lit-category-body', categoryRow: 'dsh-lit-category-row', categoryIcon: 'dsh-lit-category-icon', categoryLabel: 'dsh-lit-category-label', categoryCount: 'dsh-lit-category-count', categoryAdd: 'dsh-lit-category-add', categoryManage: 'dsh-lit-category-manage', categoryMenu: 'dsh-lit-category-menu', fieldForm: 'dsh-lit-field-form', fieldChips: 'dsh-lit-field-chips', fieldChip: 'dsh-lit-field-chip', fieldPicker: 'dsh-lit-field-picker',
  detailField: 'dsh-lit-detail-field', detailHeader: 'dsh-lit-detail-header', detailTitle: 'dsh-lit-detail-title', detailMeta: 'dsh-lit-detail-meta', detailActions: 'dsh-lit-detail-actions', detailSection: 'dsh-lit-detail-section', detailSectionTitle: 'dsh-lit-detail-section-title', detailLabel: 'dsh-lit-detail-label', detailValue: 'dsh-lit-detail-value', detailAbstract: 'dsh-lit-detail-abstract',
  backendBanner: 'dsh-lit-backend-banner', empty: 'dsh-lit-empty', footer: 'dsh-lit-footer',
} as const

const cssText = `
[data-dsh-literature-view] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base, #0d1117);
}
html[data-dsh-literature-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-dsh-literature-view] { display: block; }
html[data-dsh-literature-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([data-dsh-literature-view]),
html[data-dsh-literature-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([data-dsh-literature-view]) { display: none !important; }

.${CSS.entry} {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 12px;
  color: var(--dsw-alias-label-secondary, #a9b3c1);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
}
.${CSS.entry}:hover { color: var(--dsw-alias-label-primary, #f1f5f9); background: var(--dsw-specific-sidebar-nav-item-hover, rgba(148,163,184,.1)); }
.${CSS.entry}[data-active] { color: var(--dsw-alias-label-primary, #f1f5f9); background: var(--dsw-specific-sidebar-nav-item-active, rgba(80,130,210,.16)); font-weight: 600; }
.${CSS.entryIcon} { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.${CSS.entryLabel} { overflow: hidden; text-overflow: ellipsis; }
[data-dsh-frame][data-sidebar-collapsed] .${CSS.entry} { justify-content: center; padding: 0; }
[data-dsh-frame][data-sidebar-collapsed] .${CSS.entryLabel} { display: none; }

.${CSS.workbench} {
  --dsh-lit-bg-page: var(--dsw-alias-bg-base, #0d1117);
  --dsh-lit-bg-panel: var(--dsw-alias-bg-layer-2, #141a22);
  --dsh-lit-bg-card: var(--dsw-alias-bg-layer-1, #1a212b);
  --dsh-lit-bg-hover: var(--dsw-alias-interactive-bg-hover, rgba(148,163,184,.09));
  --dsh-lit-bg-selected: var(--dsw-specific-sidebar-nav-item-active, rgba(75,130,205,.16));
  --dsh-lit-border: var(--dsw-alias-border-l1, #29313d);
  --dsh-lit-border-strong: var(--dsw-alias-border-l2, #3a4553);
  --dsh-lit-text: var(--dsw-alias-label-primary, #edf2f7);
  --dsh-lit-text-secondary: var(--dsw-alias-label-secondary, #aab4c2);
  --dsh-lit-text-muted: var(--dsw-alias-label-tertiary, #7f8a99);
  --dsh-lit-accent: var(--dsw-alias-state-business-primary, #75a7e8);
  --dsh-lit-success: var(--dsw-alias-state-success-primary, #82ddb0);
  --dsh-lit-warning: var(--dsw-alias-state-warn-primary, #ddb56e);
  --dsh-lit-error: var(--dsw-alias-state-error-primary, #e18484);
  --dsh-lit-purple: #a99bd8;
  --dsh-lit-teal: #71c6bc;
  --dsh-lit-live-text: #91e6b8;
  --dsh-lit-live-bg: rgba(39, 174, 96, .14);
  --dsh-lit-live-border: rgba(94, 205, 139, .32);
  --dsh-lit-font-page-title: clamp(20px, 1.08vw, 22px);
  --dsh-lit-font-panel-title: 15.5px;
  --dsh-lit-font-paper-title: 14.5px;
  --dsh-lit-font-detail-title: clamp(19px, 1.05vw, 21px);
  --dsh-lit-font-body: 13.5px;
  --dsh-lit-font-secondary: 12.8px;
  --dsh-lit-font-caption: 12px;
  --dsh-lit-font-badge: 11.8px;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 10px 14px 12px;
  gap: 9px;
  color: var(--dsh-lit-text);
  background: var(--dsh-lit-bg-page);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
  overflow: hidden;
  box-sizing: border-box;
}
.${CSS.workbench} *, .${CSS.workbench} *::before, .${CSS.workbench} *::after { box-sizing: border-box; }
.${CSS.header} { display: flex; align-items: center; gap: 9px; min-width: 0; flex: none; }
.${CSS.headerActions} { display: flex; align-items: center; gap: 3px; margin-left: auto; flex: none; }
.${CSS.title} { margin: 0; font-size: var(--dsh-lit-font-page-title); line-height: 1.25; font-weight: 700; color: var(--dsh-lit-text); }
.${CSS.badge} {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
}
.${CSS.badgeLive} { color: var(--dsh-lit-live-text); background: var(--dsh-lit-live-bg); border-color: var(--dsh-lit-live-border); }
.${CSS.badgeDemo} { color: var(--dsh-lit-warning); background: rgba(181,128,43,.13); border-color: rgba(211,164,84,.28); }
.${CSS.badgeUnavailable} { color: var(--dsh-lit-error); background: rgba(190,70,70,.12); border-color: rgba(220,105,105,.28); }

.${CSS.grid} { display: flex; flex-direction: column; gap: 9px; flex: 1; min-height: 0; }
.${CSS.topRow} {
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(280px, 1fr);
  gap: 9px;
  flex: none;
  height: clamp(172px, 22vh, 218px);
  min-height: 0;
}
.${CSS.bottomRow} {
  display: grid;
  grid-template-columns: minmax(150px, 16fr) minmax(360px, 46fr) minmax(320px, 38fr);
  gap: 9px;
  flex: 1;
  min-height: 0;
}
.${CSS.panel} {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--dsh-lit-bg-panel);
  border: 1px solid var(--dsh-lit-border);
  border-radius: 11px;
  overflow: hidden;
}
.${CSS.panelTitle} {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 9px 11px 6px;
  color: var(--dsh-lit-text);
  font-size: var(--dsh-lit-font-panel-title);
  font-weight: 650;
  line-height: 1.3;
}
.${CSS.backendBanner} {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 7px 10px;
  color: var(--dsh-lit-error);
  background: rgba(190,70,70,.1);
  border: 1px solid rgba(220,105,105,.24);
  border-radius: 9px;
  font-size: 12px;
}

.${CSS.execution} { padding: 0 11px 8px; overflow: auto; }
.${CSS.executionWarning} { border-color: rgba(221,181,110,.55); background: rgba(139,91,28,.1); }
.${CSS.execution} > .${CSS.detailHeader} { padding: 0; border: 0; background: transparent; }
.${CSS.execution} .${CSS.panelTitle} { padding-left: 0; }
.${CSS.statusBadge} {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  color: var(--dsh-lit-text-secondary);
  background: var(--dsh-lit-bg-card);
  border: 1px solid var(--dsh-lit-border-strong);
  border-radius: 999px;
  font-size: 12.5px;
  line-height: 1.25;
  white-space: nowrap;
}
.${CSS.statusRunning} { color: var(--dsh-lit-accent); border-color: color-mix(in srgb, var(--dsh-lit-accent) 42%, transparent); }
.${CSS.statusOk}, .${CSS.stepDone} { color: var(--dsh-lit-success); }
.${CSS.statusWarn} { color: var(--dsh-lit-warning); border-color: rgba(221,181,110,.45); }
.${CSS.statusErr} { color: var(--dsh-lit-error); border-color: rgba(225,132,132,.45); }
.${CSS.workflowProgress} {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  list-style: none;
  margin: 7px 0 0;
  padding: 0;
}
.${CSS.workflowStage} {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  padding: 5px 12px 5px 3px;
  color: var(--dsh-lit-text-muted);
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
}
.${CSS.workflowStage}:not(:last-child)::after { content: '→'; position: absolute; right: 1px; color: var(--dsh-lit-border-strong); }
.${CSS.workflowStage}[data-state='completed'] { color: var(--dsh-lit-success); }
.${CSS.workflowStage}[data-state='running'] { color: var(--dsh-lit-accent); font-weight: 600; }
.${CSS.workflowStage}[data-state='failed'] { color: var(--dsh-lit-error); }
.${CSS.workflowStage}[data-state='user_action_required'] { color: var(--dsh-lit-warning); font-weight: 600; }
.${CSS.workflowMarker} { display: inline-flex; align-items: center; justify-content: center; width: 13px; flex: none; }
.${CSS.workflowLogs} { list-style: none; margin: 6px 0 0; padding: 0; color: var(--dsh-lit-text-secondary); font-size: var(--dsh-lit-font-secondary); line-height: 1.55; }
.${CSS.workflowLogs} li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${CSS.spinner} { display: inline-block; width: 10px; height: 10px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: dshLitSpin .8s linear infinite; }
@keyframes dshLitSpin { to { transform: rotate(360deg); } }
.${CSS.authCard} { margin-top: 7px; padding: 8px 10px; background: rgba(139,91,28,.13); border: 1px solid rgba(221,181,110,.38); border-radius: 9px; }
.${CSS.authTitle} { margin: 0 0 6px; color: var(--dsh-lit-warning); font-size: var(--dsh-lit-font-secondary); font-weight: 650; }
.${CSS.authGrid} { display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 8px; }
.${CSS.authLabel} { color: var(--dsh-lit-text-muted); font-size: var(--dsh-lit-font-caption); font-weight: 600; }
.${CSS.authValue} { color: var(--dsh-lit-text); font-size: var(--dsh-lit-font-secondary); overflow-wrap: anywhere; }

.${CSS.search} { padding: 0 11px 9px; gap: 6px; }
.${CSS.search} .${CSS.panelTitle} { padding-left: 0; }
.${CSS.searchModes} { display: flex; gap: 3px; padding: 2px; width: fit-content; background: var(--dsh-lit-bg-card); border: 1px solid var(--dsh-lit-border); border-radius: 8px; }
.${CSS.searchMode} { padding: 4px 8px; color: var(--dsh-lit-text-muted); background: transparent; border: 0; border-radius: 6px; cursor: pointer; font: inherit; font-size: var(--dsh-lit-font-caption); line-height: 1.25; }
.${CSS.searchMode}:hover { color: var(--dsh-lit-text); background: var(--dsh-lit-bg-hover); }
.${CSS.searchModeActive} { color: var(--dsh-lit-text); background: var(--dsh-lit-bg-selected); font-weight: 600; }
.${CSS.searchRow} { display: flex; gap: 7px; margin-top: auto; }
.${CSS.input} { flex: 1; min-width: 0; padding: 6px 9px; color: var(--dsh-lit-text); background: var(--dsh-lit-bg-card); border: 1px solid var(--dsh-lit-border-strong); border-radius: 7px; outline: 0; font: inherit; font-size: var(--dsh-lit-font-secondary); }
.${CSS.input}::placeholder { color: var(--dsh-lit-text-muted); }
.${CSS.input}:focus { border-color: var(--dsh-lit-accent); }
.${CSS.searchMessage} { margin: 0; color: var(--dsh-lit-text-secondary); font-size: var(--dsh-lit-font-caption); line-height: 1.45; overflow-wrap: anywhere; }
.${CSS.runnerLog} { margin: 0; padding: 8px 10px; max-height: 200px; overflow: auto; color: var(--dsh-lit-text-secondary); background: var(--dsh-lit-bg-card); border: 1px solid var(--dsh-lit-border-strong); border-radius: 7px; font-family: var(--dsh-font-markdown-code-block-small, monospace); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }

.${CSS.button} { display: inline-flex; align-items: center; justify-content: center; min-height: 30px; padding: 5px 10px; border-radius: 7px; cursor: pointer; font: inherit; font-size: var(--dsh-lit-font-caption); font-weight: 600; line-height: 1.25; text-decoration: none; white-space: nowrap; }
.${CSS.button}:disabled { opacity: .48; cursor: default; }
.${CSS.buttonPrimary} { color: var(--dsw-alias-label-primary-foreground, #fff); background: var(--dsw-alias-button-info-fill, #356eae); border: 1px solid transparent; }
.${CSS.buttonPrimary}:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover, #407dbf); }
.${CSS.buttonGhost} { color: var(--dsh-lit-text); background: transparent; border: 1px solid var(--dsh-lit-border-strong); }
.${CSS.buttonGhost}:hover:not(:disabled) { background: var(--dsh-lit-bg-hover); }

.${CSS.categories} { padding: 0 7px 9px; overflow-y: auto; }
.${CSS.categoryGroup} { margin: 3px 0 0; }
.${CSS.categorySummary} { display: flex; align-items: center; justify-content: space-between; padding: 6px 5px; color: var(--dsh-lit-text-secondary); cursor: pointer; font-size: 12.25px; font-weight: 650; letter-spacing: .01em; list-style-position: inside; }
.${CSS.categoryBody} { display: flex; flex-direction: column; gap: 2px; }
.${CSS.categoryRow} { position: relative; display: flex; align-items: center; flex-wrap: wrap; }
.${CSS.categoryItem} { position: relative; display: flex; align-items: center; gap: 6px; width: calc(100% - 28px); min-height: 31px; padding: 5px 7px 5px 9px; color: var(--dsh-lit-text-secondary); background: transparent; border: 0; border-left: 2px solid transparent; border-radius: 5px 7px 7px 5px; cursor: pointer; font: inherit; font-size: 13.75px; font-weight: 500; text-align: left; }
.${CSS.categoryItem}:hover { color: var(--dsh-lit-text); background: var(--dsh-lit-bg-hover); }
.${CSS.categoryItemActive} { color: var(--dsh-lit-text); background: var(--dsh-lit-bg-selected); border-left-color: var(--dsh-lit-accent); font-weight: 600; }
.${CSS.categoryIcon} { width: 14px; flex: none; color: var(--dsh-lit-text-muted); text-align: center; }
.${CSS.categoryLabel} { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${CSS.categoryCount} { display: inline-flex; align-items: center; min-height: 18px; padding: 1px 6px; color: var(--dsh-lit-text-muted); background: var(--dsh-lit-bg-hover); border-radius: 999px; font-size: var(--dsh-lit-font-caption); font-weight: 550; white-space: nowrap; }
.${CSS.categoryAdd}, .${CSS.categoryManage} { color: var(--dsh-lit-text-secondary); background: transparent; border: 0; cursor: pointer; font: inherit; font-size: 17px; line-height: 1; }
.${CSS.categoryManage} { width: 28px; padding: 4px; }
.${CSS.categoryMenu}, .${CSS.fieldForm}, .${CSS.fieldPicker} { display: flex; gap: 5px; flex-wrap: wrap; width: calc(100% - 17px); margin: 3px 5px 6px 12px; padding: 6px; background: var(--dsh-lit-bg-card); border: 1px solid var(--dsh-lit-border); border-radius: 7px; }
.${CSS.fieldForm} label { display: flex; flex-direction: column; gap: 3px; min-width: 100%; color: var(--dsh-lit-text-secondary); font-size: var(--dsh-lit-font-caption); font-weight: 600; }

.${CSS.papers} { padding: 0 7px 9px; overflow-y: auto; gap: 6px; }
.${CSS.paperCard} { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; color: var(--dsh-lit-text); background: var(--dsh-lit-bg-card); border: 1px solid var(--dsh-lit-border); border-left: 3px solid transparent; border-radius: 9px; cursor: pointer; font: inherit; text-align: left; transition: background .12s ease, border-color .12s ease; }
.${CSS.paperCard}:hover { background: var(--dsh-lit-bg-hover); border-color: var(--dsh-lit-border-strong); }
.${CSS.paperCardActive} { background: var(--dsh-lit-bg-selected); border-color: color-mix(in srgb, var(--dsh-lit-accent) 50%, var(--dsh-lit-border)); border-left-color: var(--dsh-lit-accent); }
.${CSS.paperTitle} { display: -webkit-box; overflow: hidden; color: var(--dsh-lit-text); font-size: var(--dsh-lit-font-paper-title); font-weight: 650; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.${CSS.paperMeta} { overflow: hidden; color: var(--dsh-lit-text-muted); font-size: var(--dsh-lit-font-secondary); line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.${CSS.paperFlags} { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.${CSS.flag} { display: inline-flex; padding: 3px 7px; color: var(--dsh-lit-text-secondary); background: rgba(130,145,165,.1); border: 1px solid rgba(130,145,165,.15); border-radius: 999px; font-size: var(--dsh-lit-font-badge); font-weight: 600; line-height: 1.25; }
.${CSS.flag}[data-kind='rank'] { color: #a8b7ca; }
.${CSS.flag}[data-kind='score'] { color: var(--dsh-lit-accent); background: rgba(75,130,205,.11); border-color: rgba(100,155,225,.19); }
.${CSS.flag}[data-kind='selected'] { color: var(--dsh-lit-success); background: rgba(54,155,103,.1); border-color: rgba(95,195,142,.18); }
.${CSS.flag}[data-kind='pdf'] { color: var(--dsh-lit-purple); background: rgba(125,102,185,.11); border-color: rgba(169,155,216,.18); }
.${CSS.flag}[data-kind='read'] { color: var(--dsh-lit-teal); background: rgba(54,148,139,.1); border-color: rgba(113,198,188,.18); }
.${CSS.flag}[data-kind='report'] { color: var(--dsh-lit-warning); background: rgba(181,128,43,.1); border-color: rgba(221,181,110,.18); }
.${CSS.flag}[data-kind='favorite'] { color: #e8b64c; background: rgba(232,182,76,.12); border-color: rgba(232,182,76,.22); }
.${CSS.checkbox} { width: 14px; height: 14px; margin: 0 6px 0 0; accent-color: var(--dsh-lit-accent); cursor: pointer; vertical-align: -2px; }

.${CSS.details} { padding: 0 11px 12px; overflow-y: auto; }
.${CSS.detailHeader} { padding: 2px 0 10px; border-bottom: 1px solid var(--dsh-lit-border); }
.${CSS.detailTitle} { margin: 0; color: var(--dsh-lit-text); font-size: var(--dsh-lit-font-detail-title); font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.${CSS.detailMeta} { margin: 5px 0 0; color: var(--dsh-lit-text-muted); font-size: var(--dsh-lit-font-secondary); line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${CSS.detailActions} { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.${CSS.detailSection} { display: flex; flex-direction: column; gap: 10px; padding: 15px 0; border-bottom: 1px solid var(--dsh-lit-border); }
.${CSS.detailSection}:last-child { border-bottom: 0; }
.${CSS.detailSectionTitle} { margin: 0; color: var(--dsh-lit-text); font-size: 15px; font-weight: 650; }
.${CSS.detailField} { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.${CSS.detailLabel} { color: var(--dsh-lit-text-muted); font-size: var(--dsh-lit-font-caption); font-weight: 600; }
.${CSS.detailValue} { color: var(--dsh-lit-text); font-size: var(--dsh-lit-font-body); line-height: 1.6; overflow-wrap: anywhere; }
.${CSS.detailAbstract} { max-height: 220px; overflow-y: auto; color: var(--dsh-lit-text-secondary); font-size: var(--dsh-lit-font-body); line-height: 1.65; overflow-wrap: anywhere; white-space: pre-wrap; }
.${CSS.fieldChips} { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.${CSS.fieldChip} { display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; color: var(--dsh-lit-text-secondary); background: var(--dsh-lit-bg-card); border: 1px solid var(--dsh-lit-border-strong); border-radius: 999px; font-size: var(--dsh-lit-font-caption); font-weight: 600; }
.${CSS.fieldChip} button { padding: 0; color: inherit; background: transparent; border: 0; cursor: pointer; font: inherit; font-size: 15px; line-height: 1; }
.${CSS.empty} { margin: auto 0; padding: 20px 10px; color: var(--dsh-lit-text-muted); font-size: var(--dsh-lit-font-secondary); text-align: center; }
.${CSS.footer} { flex: none; margin: 0; padding: 0 2px; color: var(--dsh-lit-text-muted); font-size: var(--dsh-lit-font-caption); line-height: 1.4; }

.${CSS.entry}:focus-visible, .${CSS.button}:focus-visible, .${CSS.input}:focus-visible, .${CSS.searchMode}:focus-visible, .${CSS.categoryItem}:focus-visible, .${CSS.paperCard}:focus-visible, .${CSS.categorySummary}:focus-visible { outline: 2px solid var(--dsh-lit-accent); outline-offset: 2px; }
@media (max-width: 1400px) {
  .${CSS.bottomRow} { grid-template-columns: minmax(145px, 18fr) minmax(330px, 46fr) minmax(290px, 36fr); }
  .${CSS.workflowStage} { padding-right: 9px; font-size: 12.8px; }
}
@media (max-width: 1099px) {
  .${CSS.topRow} { grid-template-columns: minmax(0, 1.4fr) minmax(250px, 1fr); }
  .${CSS.bottomRow} { grid-template-columns: minmax(320px, 1.15fr) minmax(290px, .85fr); grid-template-rows: auto minmax(0, 1fr); }
  .${CSS.categories} { grid-column: 1 / -1; max-height: 145px; flex-direction: row; flex-wrap: wrap; align-content: flex-start; overflow: auto; }
  .${CSS.categories} > .${CSS.panelTitle} { flex-basis: 100%; }
  .${CSS.categoryGroup} { min-width: 180px; flex: 1; }
  .${CSS.authGrid} { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
}
@media (max-width: 820px) {
  .${CSS.workbench} { overflow: auto; }
  .${CSS.topRow}, .${CSS.bottomRow} { display: flex; flex-direction: column; height: auto; }
  .${CSS.topRow} > *, .${CSS.bottomRow} > * { min-height: 260px; }
  .${CSS.categories} { min-height: 150px; }
}
@media (prefers-reduced-motion: reduce) { .${CSS.spinner} { animation: none; } .${CSS.paperCard} { transition: none; } }
`

let injected = false

export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-literature'
  tag.dataset.pluginCss = 'dsh-literature/styles'
  tag.textContent = cssText
  document.head.appendChild(tag)
}
