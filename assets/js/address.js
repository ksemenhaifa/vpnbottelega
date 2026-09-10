/* ============================================================
 *  Стрижи · Водоснабжение — разбор адреса, введённого жителем.
 *
 *  Житель пишет как ему удобно, всё это одно и то же:
 *      в12   в 12   в-12   В12
 *      вишневая 12   Вишнёвая, 12   ул. Вишнёвая д. 12   12 вишневая
 *      viш… — латиница тоже: v12, d12 (та же клавиша в другой раскладке)
 *
 *  SW.parseAddress(текст, net.houses) → { house } либо { error, … }
 *  SW.addressError(результат) → текст ошибки для жителя.
 * ============================================================ */
window.SW = window.SW || {};

(function () {
  /* Латиница, которой чаще всего промахиваются: та же клавиша в другой
   * раскладке (в→d, с→c, к→r) и привычный транслит (v, s, k). */
  const LAT = { d: 'в', v: 'в', b: 'в', c: 'с', s: 'с', r: 'к', k: 'к' };

  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/№/g, ' ')
    .replace(/[.,\-—–_/\\"'()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /* Убираем слова-пустышки: «ул.», «улица», «дом», «д», «номер». */
  const stripNoise = (s) => s
    .replace(/(^|\s)(ул|улица|дом|д|номер|no)(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /* Улицы вытаскиваем из самих домов, чтобы список нигде не дублировать:
   * address у дома выглядит как «ул. Вишнёвая, 12». */
  function streetsOf(houses) {
    const map = new Map();
    (houses || []).forEach((h) => {
      if (!map.has(h.street)) {
        map.set(h.street, {
          id: h.street,
          title: String(h.address || '').split(',')[0].trim(),
          key: stripNoise(norm(String(h.address || '').split(',')[0])),
          houses: [],
        });
      }
      map.get(h.street).houses.push(h);
    });
    return Array.from(map.values());
  }

  SW.parseAddress = function (input, houses) {
    const streets = streetsOf(houses);
    const text = stripNoise(norm(input));
    if (!text) return { error: 'empty', streets };

    /* Номер дома — последнее число в строке: «12 вишневая» и
     * «вишневая 12» разбираются одинаково. */
    const nums = text.match(/\d+/g);
    if (!nums) return { error: 'no-number', streets };
    const number = Number(nums[nums.length - 1]);

    /* Всё, что осталось после цифр, — название улицы. */
    const letters = text
      .replace(/\d+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((w) => (w.length === 1 && LAT[w] ? LAT[w] : w))
      .filter(Boolean)
      .join(' ');

    let cand = letters
      ? streets.filter((st) => st.key.startsWith(letters) || letters.startsWith(st.key))
      : streets.slice();

    if (!cand.length) return { error: 'street-unknown', streets, letters };

    /* Улицу не назвали или назвали неоднозначно — пробуем сузить по номеру:
     * если такой дом есть только на одной улице, вопрос снимается сам. */
    if (cand.length > 1) {
      const withHouse = cand.filter((st) => st.houses.some((h) => h.number === number));
      if (withHouse.length === 1) cand = withHouse;
      else return { error: 'street-ambiguous', streets: withHouse.length ? withHouse : cand, number };
    }

    const street = cand[0];
    const house = street.houses.find((h) => h.number === number);
    if (!house) return { error: 'house-unknown', street, number };
    return { house, street };
  };

  SW.addressError = function (res) {
    const short = (t) => String(t || '').replace(/^ул\.?\s*/i, '');
    const names = (res.streets || []).map((s) => short(s.title)).join(', ');
    switch (res && res.error) {
      case 'empty':
        return 'Напишите адрес — например «в12» или «Вишнёвая 12».';
      case 'no-number':
        return 'Не вижу номера дома. Напишите, например, «в12» или «Вишнёвая 12».';
      case 'street-unknown':
        return `Такой улицы в посёлке нет. Есть: ${names}.`;
      case 'street-ambiguous':
        return `Дом ${res.number} есть на нескольких улицах: ${names}. Добавьте улицу — хватит первой буквы, например «${(res.streets[0].key || 'в')[0]}${res.number}».`;
      case 'house-unknown': {
        const nums = res.street.houses.map((h) => h.number).sort((a, b) => a - b);
        return `На улице ${short(res.street.title)} нет дома ${res.number}. Здесь дома с ${nums[0]} по ${nums[nums.length - 1]}.`;
      }
      default:
        return 'Не понял адрес. Напишите, например, «в12» или «Вишнёвая 12».';
    }
  };
})();
