import { describe, expect, it } from "vitest";

import { parseCsv } from "@/domain/csv";
import { buildPreview, suggestMapping } from "@/domain/import-mapping";
import { clientTemplate } from "@/domain/import-templates";
import { contactsToCsv, looksLikeVCard, parseVCards } from "@/domain/vcard";

const crlf = (...lines: string[]) => `${lines.join("\r\n")}\r\n`;

describe("parseVCards", () => {
  it("reads a vCard 3.0 card as iPhone writes it", () => {
    const [contact] = parseVCards(
      crlf(
        "BEGIN:VCARD",
        "VERSION:3.0",
        "N:Popescu;Maria;;;",
        "FN:Maria Popescu",
        "TEL;type=CELL;type=VOICE;type=pref:069 123 456",
        "EMAIL;type=INTERNET;type=HOME:maria@example.com",
        "END:VCARD",
      ),
    );

    expect(contact).toEqual({
      index: 0,
      name: "Maria Popescu",
      phone: "+37369123456",
      unreadablePhone: null,
      email: "maria@example.com",
    });
  });

  it("reads a vCard 4.0 card with the number written as a URI", () => {
    const [contact] = parseVCards(
      crlf(
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Ana",
        'TEL;VALUE=uri;TYPE="cell,voice":tel:+373-69-123-457;ext=2',
        "END:VCARD",
      ),
    );

    expect(contact.phone).toBe("+37369123457");
  });

  it("keeps Cyrillic names whole", () => {
    const [contact] = parseVCards(
      crlf("BEGIN:VCARD", "VERSION:3.0", "FN:Мария Иванова", "TEL:+37369123456", "END:VCARD"),
    );

    expect(contact.name).toBe("Мария Иванова");
  });

  it("decodes the quoted-printable Cyrillic of a 2.1 Android export", () => {
    // «Мария» in UTF-8, as Samsung's contacts app writes it, soft-wrapped.
    const [contact] = parseVCards(
      crlf(
        "BEGIN:VCARD",
        "VERSION:2.1",
        "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=9C=D0=B0=D1=80=",
        "=D0=B8=D1=8F",
        "TEL;CELL:069123456",
        "END:VCARD",
      ),
    );

    expect(contact.name).toBe("Мария");
    expect(contact.phone).toBe("+37369123456");
  });

  it("joins folded lines, with a space or a tab", () => {
    const [contact] = parseVCards(
      crlf(
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Александра Констан",
        " тинова",
        "NOTE:первая строка",
        "\tвторая",
        "TEL:069",
        " 123456",
        "END:VCARD",
      ),
    );

    expect(contact.name).toBe("Александра Константинова");
    expect(contact.phone).toBe("+37369123456");
  });

  describe("with several numbers", () => {
    it("takes the preferred one", () => {
      const [contact] = parseVCards(
        crlf(
          "BEGIN:VCARD",
          "FN:Ирина",
          "TEL;TYPE=CELL:069111111",
          "TEL;TYPE=CELL,pref:069222222",
          "END:VCARD",
        ),
      );

      expect(contact.phone).toBe("+37369222222");
    });

    it("takes the vCard 4.0 PREF parameter as preferred", () => {
      const [contact] = parseVCards(
        crlf("BEGIN:VCARD", "FN:Ирина", "TEL;TYPE=cell:069111111", "TEL;PREF=1:069222222", "END:VCARD"),
      );

      expect(contact.phone).toBe("+37369222222");
    });

    it("takes the mobile over a landline listed first", () => {
      const [contact] = parseVCards(
        crlf(
          "BEGIN:VCARD",
          "FN:Ольга",
          "TEL;TYPE=HOME:022123456",
          "TEL;TYPE=WORK:022654321",
          "item1.TEL;type=CELL:079123456",
          "END:VCARD",
        ),
      );

      expect(contact.phone).toBe("+37379123456");
    });

    it("falls through to a number it can read", () => {
      // A Ukrainian mobile first: `normalizePhone` reads Moldova and Romania only.
      const [contact] = parseVCards(
        crlf("BEGIN:VCARD", "FN:Оксана", "TEL;TYPE=CELL:+380501234567", "TEL;TYPE=HOME:069123456", "END:VCARD"),
      );

      expect(contact.phone).toBe("+37369123456");
      expect(contact.unreadablePhone).toBeNull();
    });

    it("keeps the first number as written when none can be read", () => {
      const [contact] = parseVCards(
        crlf("BEGIN:VCARD", "FN:Оксана", "TEL;TYPE=CELL:+380 50 123 45 67", "TEL:112", "END:VCARD"),
      );

      expect(contact.phone).toBeNull();
      expect(contact.unreadablePhone).toBe("+380 50 123 45 67");
    });
  });

  it("keeps a contact with no phone, to import by name", () => {
    const [contact] = parseVCards(crlf("BEGIN:VCARD", "FN:Без Номера", "EMAIL:no@example.com", "END:VCARD"));

    expect(contact).toMatchObject({ name: "Без Номера", phone: null, unreadablePhone: null, email: "no@example.com" });
  });

  it("names a card from N, then ORG, then its number, when FN is missing", () => {
    const contacts = parseVCards(
      crlf(
        "BEGIN:VCARD",
        "N:Иванова;Анна;Сергеевна;;",
        "END:VCARD",
        "BEGIN:VCARD",
        "ORG:Салон «Лак\\; и гель»;Ресепшн",
        "END:VCARD",
        "BEGIN:VCARD",
        "TEL:069123456",
        "END:VCARD",
      ),
    );

    expect(contacts.map((contact) => contact.name)).toEqual([
      "Анна Сергеевна Иванова",
      "Салон «Лак; и гель»",
      "069123456",
    ]);
  });

  it("unescapes commas, semicolons and line breaks in a name", () => {
    const [contact] = parseVCards(crlf("BEGIN:VCARD", "FN:Мария\\, мастер\\nпо бровям", "END:VCARD"));

    expect(contact.name).toBe("Мария, мастер по бровям");
  });

  it("skips what it cannot read and keeps the cards around it", () => {
    const contacts = parseVCards(
      crlf(
        "BEGIN:VCARD",
        "FN:Первая",
        "это не свойство",
        ":без имени",
        "TEL;TYPE=CELL:069123456",
        "END:VCARD",
        "мусор между карточками",
        "BEGIN:VCARD",
        "FN:Вторая без END",
        "BEGIN:VCARD",
        "FN:Третья",
        "END:VCARD",
        "BEGIN:VCARD",
        "VERSION:3.0",
        "END:VCARD",
      ),
    );

    // The empty fourth card has nothing to call it by and is not offered.
    expect(contacts.map((contact) => [contact.index, contact.name])).toEqual([
      [0, "Первая"],
      [1, "Вторая без END"],
      [2, "Третья"],
    ]);
    expect(contacts[0].phone).toBe("+37369123456");
  });

  it("reads LF and bare CR line endings, and a BOM", () => {
    const text = "﻿BEGIN:VCARD\nFN:Лина\rTEL:069123456\nEND:VCARD";

    expect(parseVCards(text)).toEqual([
      { index: 0, name: "Лина", phone: "+37369123456", unreadablePhone: null, email: null },
    ]);
  });

  it("reads lowercase property names as it reads uppercase ones", () => {
    const [contact] = parseVCards(crlf("begin:vcard", "fn:Вера", "tel;type=cell:069123456", "end:vcard"));

    expect(contact).toMatchObject({ name: "Вера", phone: "+37369123456" });
  });

  it("finds nothing in a file that is not a vCard", () => {
    expect(parseVCards("Имя;Телефон\nМария;069123456\n")).toEqual([]);
  });
});

describe("looksLikeVCard", () => {
  it("tells a contacts file from a CSV", () => {
    expect(looksLikeVCard(crlf("BEGIN:VCARD", "FN:Мария", "END:VCARD"))).toBe(true);
    expect(looksLikeVCard("\r\n  begin:vcard\r\nFN:x\r\n")).toBe(true);
    expect(looksLikeVCard("Имя;Телефон\nBEGIN:VCARD;069\n")).toBe(false);
  });
});

describe("contactsToCsv", () => {
  it("is a client file the import maps without help", () => {
    const contacts = parseVCards(
      crlf(
        "BEGIN:VCARD",
        'FN:Мария "Маша" =Попеску',
        "TEL:069123456",
        "EMAIL:maria@example.com",
        "END:VCARD",
        "BEGIN:VCARD",
        "FN:Анна\\, Кишинёв",
        "END:VCARD",
      ),
    );

    const parsed = parseCsv(contactsToCsv(contacts));
    const mapping = suggestMapping(clientTemplate, parsed.headers);
    const preview = buildPreview(clientTemplate, mapping, parsed.rows);

    expect(mapping).toEqual({ external_id: null, name: 0, phone: 1, email: 2 });
    expect(preview.failed).toEqual([]);
    expect(preview.rows.map((row) => row.values)).toEqual([
      // The leading `=` survives as part of the name: no apostrophe is added.
      { external_id: null, name: 'Мария "Маша" =Попеску', phone: "+37369123456", email: "maria@example.com" },
      { external_id: null, name: "Анна, Кишинёв", phone: null, email: null },
    ]);
  });

  it("gives the same contact the same identity on every export", () => {
    const card = crlf("BEGIN:VCARD", "FN:Мария", "TEL:+373 69 123 456", "END:VCARD");
    const reformatted = crlf("BEGIN:VCARD", "FN:Мария", "TEL;TYPE=CELL:069-123-456", "END:VCARD");

    const identity = (text: string) => {
      const parsed = parseCsv(contactsToCsv(parseVCards(text)));
      return buildPreview(clientTemplate, suggestMapping(clientTemplate, parsed.headers), parsed.rows).rows[0]
        .externalId;
    };

    expect(identity(card)).toBe(identity(reformatted));
  });
});
