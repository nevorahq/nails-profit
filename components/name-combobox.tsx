"use client";

import { useState, type ReactNode } from "react";

/**
 * A free-text field that suggests from a fixed catalogue.
 *
 * Used by the material form and the service form, which ask the same thing of
 * their first field: offer what the product already knows, and get out of the
 * way of a name it does not. Free text is the point — a studio's own service is
 * as valid as a catalogue entry, so a suggestion is never required and the
 * value is whatever was typed.
 *
 * Extracted rather than copied: the keyboard handling is the part that goes
 * wrong quietly. Arrow keys wrap, Escape closes without clearing, Enter picks
 * the active row only while the list is open, and `mousedown` is prevented so
 * clicking an option does not blur the input before the click lands.
 */
export type ComboboxOption = Readonly<{
  /** Stable per option, used for the DOM id the input points `aria-activedescendant` at. */
  key: string;
  label: string;
  /** Secondary line: the unit, the packaging, whatever tells two rows apart. */
  hint?: ReactNode;
  /** Optional heading rendered above this option; repeat it and it prints once. */
  group?: string;
}>;

export function NameCombobox({
  id,
  label,
  value,
  placeholder,
  options,
  title,
  emptyLabel,
  footnote,
  required,
  maxLength,
  name,
  onChange,
  onSelect,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  options: readonly ComboboxOption[];
  /** Heading of the popover, naming what is being offered. */
  title: string;
  emptyLabel: string;
  /** Reassurance that typing something absent from the list is allowed. */
  footnote: string;
  required?: boolean;
  maxLength?: number;
  name?: string;
  onChange: (value: string) => void;
  onSelect: (option: ComboboxOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const choose = (option: ComboboxOption) => {
    onSelect(option);
    setOpen(false);
    setActive(0);
  };

  return (
    <label
      className="name-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {label}
      <span className="name-combobox-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          name={name}
          type="search"
          required={required}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-activedescendant={open && options[active] ? `${id}-${options[active].key}` : undefined}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (options.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => (index + 1) % options.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => (index - 1 + options.length) % options.length);
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              choose(options[active]);
            }
          }}
        />
      </span>
      {open && (
        <div className="name-suggestions-popover">
          <span className="name-suggestions-title">{title}</span>
          {options.length > 0 ? (
            <ul id={`${id}-options`} role="listbox">
              {options.map((option, index) => (
                <li key={option.key}>
                  {/* One heading per group, and `presentation` keeps it out of
                      the option list so arrow keys still move between rows. */}
                  {option.group !== undefined && option.group !== options[index - 1]?.group && (
                    <span className="name-suggestions-group" role="presentation">
                      {option.group}
                    </span>
                  )}
                  <button
                    id={`${id}-${option.key}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={index === active ? "is-active" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(option)}
                  >
                    <span>{option.label}</span>
                    {option.hint !== undefined && <small>{option.hint}</small>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className="name-suggestions-empty">{emptyLabel}</span>
          )}
          <span className="name-suggestions-custom">{footnote}</span>
        </div>
      )}
    </label>
  );
}
