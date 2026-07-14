type DestructiveButton = {
  buttonEl: { addClass(className: string): void };
  setDestructive?: () => unknown;
};

export function setDestructiveCompat<T extends DestructiveButton>(_button: T): T {
  const button = _button;
  if (typeof button.setDestructive === "function") {
    button.setDestructive();
  } else {
    // The legacy button API applied this stable Obsidian class before the 1.13 method existed.
    // Use the class directly on older runtimes without retaining a deprecated API call in source.
    button.buttonEl.addClass("mod-warning");
  }
  return button;
}

export function refreshSettingTab<TContainer>(
  tab: { update?: () => void; containerEl: TContainer },
  renderLegacy: (containerEl: TContainer) => void
): void {
  if (typeof tab.update === "function") {
    tab.update();
    return;
  }
  renderLegacy(tab.containerEl);
}
