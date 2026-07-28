/**
 * Form validation helper
 * Usage:
 *   validateField(input, 'required') — checks if empty
 *   validateField(input, 'email') — checks email format
 *   validateField(input, 'minlen:4') — checks min length
 *   validateField(input, 'number') — checks positive number
 *   clearFieldError(input) — removes error state
 *   validateForm(formEl) — validates all [data-validate] inputs, returns true/false
 */
(function() {
  'use strict';

  var messages = {
    required: 'Toto pole je povinne',
    email: 'Zadajte platny email',
    minlen: 'Minimalna dlzka je {n} znakov',
    number: 'Zadajte kladne cislo',
    phone: 'Zadajte platne telefonne cislo',
    pin: 'PIN musi mat presne 4 cislice'
  };

  function showFieldError(input, msg) {
    clearFieldError(input);
    var wrapper = input.closest('.form-group') || input.closest('.u-modal-field') || input.parentElement;
    wrapper.classList.add('field-error');
    var errorEl = document.createElement('div');
    errorEl.className = 'field-error-msg';
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
    input.after(errorEl);
    input.setAttribute('aria-invalid', 'true');
  }

  function clearFieldError(input) {
    var wrapper = input.closest('.form-group') || input.closest('.u-modal-field') || input.parentElement;
    wrapper.classList.remove('field-error');
    wrapper.classList.remove('field-valid');
    var existing = wrapper.querySelector('.field-error-msg');
    if (existing) existing.remove();
    input.removeAttribute('aria-invalid');
  }

  function showFieldSuccess(input) {
    var wrapper = input.closest('.form-group') || input.closest('.u-modal-field') || input.parentElement;
    wrapper.classList.remove('field-error');
    wrapper.classList.add('field-valid');
    var existing = wrapper.querySelector('.field-error-msg');
    if (existing) existing.remove();
    input.removeAttribute('aria-invalid');
  }

  function validateField(input, rule) {
    var val = input.value.trim();
    var parts = rule.split(':');
    var type = parts[0];
    var param = parts[1];

    clearFieldError(input);

    switch(type) {
      case 'required':
        if (!val) { showFieldError(input, messages.required); return false; }
        break;
      case 'email':
        if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { showFieldError(input, messages.email); return false; }
        break;
      case 'minlen':
        if (val && val.length < parseInt(param)) { showFieldError(input, messages.minlen.replace('{n}', param)); return false; }
        break;
      case 'number':
        if (val && (isNaN(val) || parseFloat(val) < 0)) { showFieldError(input, messages.number); return false; }
        break;
      case 'pin':
        if (val && !/^\d{4}$/.test(val)) { showFieldError(input, messages.pin); return false; }
        break;
    }
    if (val) showFieldSuccess(input);
    return true;
  }

  function validateForm(container) {
    var inputs = container.querySelectorAll('[data-validate]');
    var valid = true;
    var firstBad = null;
    inputs.forEach(function(input) {
      var rules = input.getAttribute('data-validate').split('|');
      rules.forEach(function(rule) {
        if (!validateField(input, rule)) {
          valid = false;
          if (!firstBad) firstBad = input;
        }
      });
    });
    // Bez tohoto sa na dlhom formulári (napr. produkt v admine) po kliknutí
    // na „Uložiť" navonok nestalo NIČ: hláška sa vykreslila pri poli, ktoré
    // je odrolované mimo viewport modálu, takže to vyzeralo ako nefunkčné
    // tlačidlo. Netýka sa to len čítačiek obrazovky — postihnutý je aj
    // bežný vidiaci používateľ.
    if (firstBad) {
      try {
        firstBad.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) {
        firstBad.scrollIntoView();
      }
      // preventScroll — scrollIntoView vyššie už polohu vyriešil plynulo,
      // focus() by ju skokom prepísal.
      try { firstBad.focus({ preventScroll: true }); } catch (e) { firstBad.focus(); }
    }
    return valid;
  }

  function wireValidation(container) {
    container.querySelectorAll('[data-validate]').forEach(function(input) {
      input.addEventListener('blur', function() {
        var rules = this.getAttribute('data-validate').split('|');
        var self = this;
        rules.forEach(function(rule) { validateField(self, rule); });
      });
      input.addEventListener('input', function() { clearFieldError(this); });
    });
  }

  window.validateField = validateField;
  window.clearFieldError = clearFieldError;
  window.showFieldError = showFieldError;
  window.showFieldSuccess = showFieldSuccess;
  window.validateForm = validateForm;
  window.wireValidation = wireValidation;
})();
