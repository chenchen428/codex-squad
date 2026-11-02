(function () {
  'use strict';

  var root = document.documentElement;
  var langButtons = Array.prototype.slice.call(document.querySelectorAll('[data-set-lang]'));
  var themeButton = document.getElementById('theme-toggle');
  var copyButton = document.getElementById('copy-build');
  var copyStatus = document.getElementById('copy-status');

  function currentLang() {
    return root.getAttribute('data-lang') === 'en' ? 'en' : 'zh';
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {}
  }

  function setLang(lang) {
    var next = lang === 'en' ? 'en' : 'zh';
    root.setAttribute('data-lang', next);
    root.setAttribute('lang', next === 'zh' ? 'zh-CN' : 'en');
    store('codex-squad-lang', next);
    langButtons.forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-set-lang') === next));
    });
    if (copyStatus) {
      copyStatus.textContent = '';
    }
  }

  function setTheme(theme) {
    var next = theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    store('codex-squad-theme', next);
    if (themeButton) {
      themeButton.setAttribute('aria-pressed', String(next === 'dark'));
    }
  }

  function initialTheme() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  langButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      setLang(button.getAttribute('data-set-lang'));
    });
  });
  setLang(currentLang());

  if (themeButton) {
    themeButton.setAttribute('aria-pressed', String(initialTheme() === 'dark'));
    themeButton.addEventListener('click', function () {
      setTheme(initialTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  function reportCopy(message) {
    if (copyStatus) {
      copyStatus.textContent = message;
    }
  }

  function selectCommandText(target) {
    try {
      var range = document.createRange();
      range.selectNodeContents(target);
      var selection = window.getSelection();
      if (!selection) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (error) {
      return false;
    }
  }

  if (copyButton) {
    copyButton.addEventListener('click', async function () {
      var target = document.getElementById(copyButton.getAttribute('data-copy-target') || '');
      if (!target) {
        reportCopy(currentLang() === 'zh' ? '命令文本不可用，请直接选择页面中的命令。' : 'Command text is unavailable; select it on the page instead.');
        return;
      }
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(target.textContent.trim());
          reportCopy(currentLang() === 'zh' ? '命令已复制。' : 'Commands copied.');
          return;
        } catch (error) {}
      }
      fallbackCopy(target);
    });
  }

  function fallbackCopy(target) {
    var selected = selectCommandText(target);
    if (currentLang() === 'zh') {
      reportCopy(selected ? '复制不可用；命令文本已选中，请手动复制。' : '复制不可用；命令文本可直接选择后手动复制。');
    } else {
      reportCopy(selected ? 'Copy is unavailable. The command text is selected for manual copying.' : 'Copy is unavailable. Select the command text manually.');
    }
  }
}());
