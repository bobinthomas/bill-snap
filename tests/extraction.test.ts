import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { classify } from "../src/extraction/gate";
import { createExtractionService } from "../src/extraction/pipeline";
import { extractFromText, isGarbageOcrText, mergeKnownVendors } from "../src/extraction/regex";
import type { WorkersAi } from "../src/extraction/workers-ai";
import {
  computeGst,
  normaliseDate,
  normaliseExtraction,
  parseAmount,
  round2,
  validateAbn,
} from "../src/extraction/validate";
import { fillCategoryHint, type VendorCategorySuggestion } from "../src/extraction/vendor-categories";
import type { BillExtraction } from "../src/types";

const CONFIG = loadConfig({});

function extraction(overrides: Partial<BillExtraction> = {}): BillExtraction {
  return {
    amount: { value: 245.0, confidence: 0.97 },
    date: { value: "2026-08-10", confidence: 0.99 },
    vendor: { value: "Telstra", confidence: 0.95 },
    abn: { value: "51 824 753 556", confidence: 0.9 },
    gst: { value: 22.27, confidence: 0.92 },
    gst_basis: "inclusive",
    invoice_number: { value: "INV-2847", confidence: 0.88 },
    due_date: { value: "2026-09-10", confidence: 0.85 },
    category_hint: { value: "utilities", confidence: 0.6 },
    ...overrides,
  };
}

describe("validateAbn (checksum)", () => {
  it("accepts a valid ABN", () => expect(validateAbn("51 824 753 556")).toBe(true));
  it("accepts an unspaced valid ABN", () => expect(validateAbn("51824753556")).toBe(true));
  it("rejects a checksum-invalid ABN", () => expect(validateAbn("12 345 678 901")).toBe(false));
  it("rejects malformed input", () => {
    expect(validateAbn("123")).toBe(false);
    expect(validateAbn("00000000000")).toBe(false);
  });
});

describe("normaliseDate", () => {
  it("normalises AU DD/MM/YYYY", () => expect(normaliseDate("10/08/2026")).toBe("2026-08-10"));
  it("normalises DD-MMM-YYYY", () => expect(normaliseDate("10-Aug-2026")).toBe("2026-08-10"));
  it("passes ISO through", () => expect(normaliseDate("2026-08-10")).toBe("2026-08-10"));
  it("rejects impossible dates", () => expect(normaliseDate("31/02/2026")).toBeNull());
  it("rejects garbage", () => expect(normaliseDate("not a date")).toBeNull());
  it("normalises dash/dot separators and two-digit years (OCR shapes)", () => {
    expect(normaliseDate("03-08-2026")).toBe("2026-08-03");
    expect(normaliseDate("26.08.2026")).toBe("2026-08-26");
    expect(normaliseDate("3/8/26")).toBe("2026-08-03");
    expect(normaliseDate("10-Aug-26")).toBe("2026-08-10");
    expect(normaliseDate("08-10-26")).toBe("2026-10-08");
  });

  it("normalises spaced separators and space-separated month names", () => {
    expect(normaliseDate("09 / 05 / 2009")).toBe("2009-05-09");
    expect(normaliseDate("09. 05. 2009")).toBe("2009-05-09");
    expect(normaliseDate("09 May 2009")).toBe("2009-05-09");
    expect(normaliseDate("9 September 2009")).toBe("2009-09-09");
    expect(normaliseDate("09 May 09")).toBe("2009-05-09");
  });
});

describe("parseAmount", () => {
  it.each([
    ["$4,850.00", 4850],
    ["AUD 4850", 4850],
    ["1,234.56", 1234.56],
    ["500", 500],
    ["245.5", 245.5],
  ])("parses %s → %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });
  it("rejects non-amounts", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("computeGst", () => {
  it("inclusive → amount / 11", () => expect(computeGst(245, "inclusive", true)).toBe(round2(245 / 11)));
  it("exclusive → amount × 0.10", () => expect(computeGst(245, "exclusive", true)).toBe(24.5));
  it("none → null", () => expect(computeGst(245, "none", true)).toBeNull());
  it("non-registered → null regardless of basis", () => {
    expect(computeGst(245, "inclusive", false)).toBeNull();
    expect(computeGst(245, "exclusive", false)).toBeNull();
  });
});

describe("classify (§5.4 gating)", () => {
  const t = CONFIG.extraction;

  it("high: amount + date high, vendor present", () => {
    expect(classify(extraction(), t)).toBe("high");
  });

  it("partial: vendor missing", () => {
    expect(classify(extraction({ vendor: { value: null, confidence: 0 } }), t)).toBe("partial");
  });

  it("partial: date low", () => {
    expect(classify(extraction({ date: { value: "2026-08-10", confidence: 0.5 } }), t)).toBe("partial");
  });

  it("partial: amount in the low band (0.70–0.89)", () => {
    expect(classify(extraction({ amount: { value: 245, confidence: 0.75 } }), t)).toBe("partial");
  });

  it("low: amount below the low threshold", () => {
    expect(classify(extraction({ amount: { value: 245, confidence: 0.4 } }), t)).toBe("low");
  });

  it("low: amount absent", () => {
    expect(classify(extraction({ amount: { value: null, confidence: 0 } }), t)).toBe("low");
  });
});

describe("normaliseExtraction (shared validation layer)", () => {
  it("recomputes GST from gst_basis, never verbatim", () => {
    const out = normaliseExtraction(extraction({ gst: { value: 999, confidence: 0.9 } }), true);
    expect(out.gst.value).toBe(round2(245 / 11));
  });

  it("nulls GST for non-registered businesses", () => {
    const out = normaliseExtraction(extraction(), false);
    expect(out.gst.value).toBeNull();
  });

  it("drops an ABN that fails the checksum", () => {
    const out = normaliseExtraction(extraction({ abn: { value: "12 345 678 901", confidence: 0.95 } }), true);
    expect(out.abn.value).toBeNull();
  });

  it("drops a fabricated all-zero invoice number (LLaVA hallucination)", () => {
    const out = normaliseExtraction(
      extraction({ invoice_number: { value: "00000000000000000000", confidence: 0.95 } }),
      true,
    );
    expect(out.invoice_number.value).toBeNull();
  });

  it("keeps a real-looking invoice number", () => {
    const out = normaliseExtraction(
      extraction({ invoice_number: { value: "INV-99211", confidence: 0.95 } }),
      true,
    );
    expect(out.invoice_number.value).toBe("INV-99211");
  });

  it("normalises AU dates to ISO", () => {
    const out = normaliseExtraction(extraction({ date: { value: "10/08/2026", confidence: 0.99 } }), true);
    expect(out.date.value).toBe("2026-08-10");
  });
});

describe("isGarbageOcrText", () => {
  it("flags dense short-fragment noise as garbage", () => {
    // The real VRAJ RESTAURANT read: near-total misfire, dominated by 1-2
    // letter fragments.
    expect(isGarbageOcrText("Ey ral RO 3h ry SDS TS a er ae RAV tg Le AY FUSES h")).toBe(true);
  });

  it("does not flag short typed or shorthand OCR text", () => {
    expect(isGarbageOcrText("wages 500 rajesh")).toBe(false);
    expect(isGarbageOcrText("internet 99.95 telstra gst")).toBe(false);
  });

  it("does not flag a real (if messy) receipt read", () => {
    expect(
      isGarbageOcrText(
        "RELIANCE HYPERMART LIMITED MADURAI IN DATE 09/05/2009 TIME 19:07:22 AMOUNT Rs 321.68 TOTAL Rs 321.68",
      ),
    ).toBe(false);
  });
});

describe("extractFromText (regex fallback, §5.3)", () => {
  it("parses `wages 500 rajesh`", () => {
    const out = extractFromText("wages 500 rajesh");
    expect(out.amount.value).toBe(500);
    expect(out.category_hint.value).toBe("wages");
    expect(out.vendor.value).toBe("rajesh");
  });

  it("parses `$245.00 utilities telstra`", () => {
    const out = extractFromText("$245.00 utilities telstra");
    expect(out.amount.value).toBe(245);
    expect(out.category_hint.value).toBe("utilities");
    expect(out.vendor.value).toBe("telstra");
  });

  it("detects an ABN and validates the checksum", () => {
    const out = extractFromText("ABN: 51 824 753 556 Total $100.00");
    expect(out.abn.value).toBe("51 824 753 556");
  });

  it("detects GST inclusive basis", () => {
    expect(extractFromText("GST INCLUSIVE $100.00").gst_basis).toBe("inclusive");
    expect(extractFromText("$100.00 inc GST").gst_basis).toBe("inclusive");
    expect(extractFromText("$100.00").gst_basis).toBe("none");
  });

  it("does not misread a date as an amount", () => {
    const out = extractFromText("10/08/2026 Telstra $245.00");
    expect(out.amount.value).toBe(245);
  });

  it("does not misread a dash-separated date as an amount", () => {
    // OCR commonly mangles date separators — "03-08-2026" must yield the date,
    // never "03" → $3.00.
    const out = extractFromText("Telstra 03-08-2026 Total $245.00");
    expect(out.amount.value).toBe(245);
    expect(out.date.value).toBe("03-08-2026");
  });

  it("captures a two-digit-year date without leaking its digits", () => {
    const out = extractFromText("Origin Energy 3/8/26 Total $267.30");
    expect(out.amount.value).toBe(267.3);
    expect(out.date.value).toBe("3/8/26");
  });

  it("does not read a mangled date fragment as an amount", () => {
    // "03/08 2026" (year split off) must not yield "03" as the amount.
    const out = extractFromText("mT pr 03/08 2026 sion");
    expect(out.amount.value).toBeNull();
  });

  it("applies the date-fragment guard to the vendor pass on typed text", () => {
    // A fragment findDate misses ("03/08 2026") must not leak into the vendor
    // either — the guard strips it before both passes, not just for the amount.
    const out = extractFromText("telstra 245.00 03/08 2026");
    expect(out.amount.value).toBe(245);
    expect(out.vendor.value).toBe("telstra"); // was "03/08"
  });

  it("guards a dash month-name date like 10-Aug-2026", () => {
    const out = extractFromText("10-Aug-2026 Telstra $245.00");
    expect(out.amount.value).toBe(245);
    expect(out.date.value).toBe("10-Aug-2026"); // raw; ISO normalisation is the validate layer's job
    expect(out.vendor.value).toBe("Telstra");
  });

  it("captures a space-month date on a DATE-label line", () => {
    // OCR keeps the "DATE :" label but drops the dashes — the label fallback
    // must capture the date, and the guard must stop "09" from winning the
    // amount (the §5.7 leak).
    const out = extractFromText(
      "DATE : 09 May 2009    TIME : 19:07:22\nAMOUNT    Rs            321.68\nTOTAL     Rs            321.68",
    );
    expect(out.date.value).toBe("09 May 2009"); // raw; ISO normalisation is the validate layer's job
    expect(out.amount.value).toBe(321.68);
  });

  it("captures spaced numeric separators on a DATE-label line", () => {
    const out = extractFromText("DATED : 09 / 05 / 2009\nTotal $245.00");
    expect(out.date.value).toBe("09 / 05 / 2009");
    expect(out.amount.value).toBe(245);
  });

  it("requires the DATE label for loose date shapes", () => {
    // No label → the space-month shape is not captured as the date, but the
    // guard still strips it so "09" can't win the amount.
    const out = extractFromText("Payment 09 May 2009\nTotal $245.00");
    expect(out.date.value).toBeNull();
    expect(out.amount.value).toBe(245);
  });

  it("prefers a standard date shape over the label fallback", () => {
    const out = extractFromText("10/08/2026\nDATE : 09 May 2009\nTotal $245.00");
    expect(out.date.value).toBe("10/08/2026");
  });

  it("strips clock times so their digits never become the amount or vendor", () => {
    const out = extractFromText("lunch 12:30 50");
    expect(out.amount.value).toBe(50);
    expect(out.vendor.value).toBe("lunch");
  });

  it("strips GST markers from the vendor name", () => {
    const out = extractFromText("internet 100 telstra gst");
    expect(out.vendor.value).toBe("telstra");
    expect(out.gst_basis).toBe("exclusive");
  });

  it("cleans a multi-line OCR heading down to the vendor", () => {
    const out = extractFromText(
      "Internet Bill\nOrigin Energy\nInvoice No. 123\nAmount: $245.00\nGST: $22.27\nDate: 10/08/2026",
    );
    expect(out.vendor.value).toBe("Origin Energy"); // heading "internet" stripped, name kept
    expect(out.category_hint.value).toBe("utilities");
    expect(out.amount.value).toBe(245);
    expect(out.date.value).toBe("10/08/2026"); // raw; ISO normalisation is the validate layer's job
  });

  it("strips trailing hyphens and bullet artifacts", () => {
    const out = extractFromText("- Origin-\n- Total: $245.00 -");
    expect(out.vendor.value).toBe("Origin");
  });

  it("does not leak the date into the vendor", () => {
    const out = extractFromText("10/08/2026 Telstra $245.00");
    expect(out.vendor.value).toBe("Telstra");
  });

  it("keeps possessive vendor names intact", () => {
    const out = extractFromText("Bill's Plumbing $500.00");
    expect(out.vendor.value).toBe("Bill's Plumbing");
  });

  it("keeps the vendor when alias-stripping leaves only noise", () => {
    // Stripping "telstra" would leave "GST INCLUSIVE" (all noise) — the alias
    // word was the real vendor, so it must survive.
    const out = extractFromText("10/08/2026 Telstra GST INCLUSIVE $245.00");
    expect(out.vendor.value).toBe("Telstra");
    expect(out.gst_basis).toBe("inclusive");
    expect(out.amount.value).toBe(245);
  });

  it("rejoins a word split across an OCR line wrap", () => {
    // "Telstra" breaks at the syllable boundary ("Tel-" + "stra") — the
    // mechanical join strips the wrap hyphen and concatenates.
    const out = extractFromText("Tel-\nstra\n10/08/2026\nAmount: $99.95");
    expect(out.vendor.value).toBe("Telstra");
    expect(out.amount.value).toBe(99.95);
  });

  it("rejoins across a CRLF wrap with trailing spaces", () => {
    const out = extractFromText("Bunnings Warehou- \r\nse\n10/08/2026\nTotal: $214.90");
    expect(out.vendor.value).toBe("Bunnings Warehouse");
  });

  it("leaves real hyphenated names untouched", () => {
    const out = extractFromText("Green-Haven Plumbing\n10/08/2026\nAmount: $500.00");
    expect(out.vendor.value).toBe("Green-Haven Plumbing");
  });

  it("does not rejoin a wrap inside a hyphenated compound", () => {
    // "mother-in-" + "law" is a real compound wrapped mid-word — joining would
    // corrupt it to "mother-inlaw", so the guard must skip it.
    const out = extractFromText("mother-in-\nlaw\n10/08/2026\nAmount: $50.00");
    expect(out.vendor.value).toBe("mother-in law");
  });

  it("prefers the Total-line amount over the first $", () => {
    const out = extractFromText(
      "Origin Energy\n10/08/2026\nUsage charges: $220.00\nSupply charge: $25.00\nGST: $22.27\nTotal: $267.27",
    );
    expect(out.amount.value).toBe(267.27);
  });

  it("ignores Subtotal lines when a Total line exists", () => {
    const out = extractFromText("Subtotal: $220.00\nGST: $22.00\nTotal: $242.00");
    expect(out.amount.value).toBe(242);
  });

  it("prefers Balance / Amount due lines too", () => {
    expect(extractFromText("Balance: $1,234.56\nOther charges $500.00").amount.value).toBe(1234.56);
    expect(extractFromText("Other charges $500.00\nAmount due: $1,234.56").amount.value).toBe(1234.56);
  });

  it("falls back to the first $ when no Total line exists", () => {
    const out = extractFromText("Usage $220.00\nGST $22.27");
    expect(out.amount.value).toBe(220);
  });

  it("does not pick an invoice number from a Total line", () => {
    const out = extractFromText("Total Invoice No. 2847\nUsage: $220.00");
    expect(out.amount.value).toBe(220);
  });

  it("ties total-line amounts by the largest (stray Total GST can't win)", () => {
    const out = extractFromText("Total GST: $22.27\nUsage $220.00\nTotal: $267.27");
    expect(out.amount.value).toBe(267.27);
  });

  it("takes the largest amount on a single Total line", () => {
    const out = extractFromText("Total (ex GST) $245.00 Total (inc GST) $269.50");
    expect(out.amount.value).toBe(269.5);
  });

  it("ignores credit lines when choosing the total", () => {
    const out = extractFromText("Credit balance: $5,000.00\nAmount due: $245.00");
    expect(out.amount.value).toBe(245);
  });

  it("reads the total from the line below the label", () => {
    const out = extractFromText("Origin Energy\n10/08/2026\nUsage $220.00\nTotal\n$267.27");
    expect(out.amount.value).toBe(267.27);
  });

  it("reads the total below the label past a blank line", () => {
    const out = extractFromText("Amount due:\n\n$267.27");
    expect(out.amount.value).toBe(267.27);
  });

  it("does not chase the value past an intervening content line", () => {
    // A table header ("Item Total") must not reach down to a line item.
    const out = extractFromText("Item Total\nInternet\n$99.95");
    expect(out.amount.value).toBe(99.95);
  });

  it("reads an OCR-mangled TOTAL with an Rs currency (thermal receipt)", () => {
    // Real HDFC/Reliance receipt: OCR read "TOTAL" as "101AL" and the receipt
    // is in Rupees — the fuzzy total match + Rs currency must yield 321.68,
    // not the first digit "5" from the noise at the top of the page.
    const out = extractFromText("[5] Hore nan\nAMOUNT Rs 32\n101AL Rs 321.68");
    expect(out.amount.value).toBe(321.68);
  });

  it("extracts an Rs-prefixed amount without any total line", () => {
    expect(extractFromText("Rs 321.68").amount.value).toBe(321.68);
    expect(extractFromText("INR 1,250.00").amount.value).toBe(1250);
  });

  it("does not read a postal code or reference number as the amount", () => {
    // Real VRAJ RESTAURANT receipt: garbage OCR left only noise plus the
    // address pincode ("(Gujarat) - 361335") and reference numbers ("Bill
    // No: 6424", "Token No: 45") intact — none of them may win the
    // bare-number fallback in place of the real total ($1,249.00, never OCR'd).
    const out = extractFromText(
      "Ey ral RO 3h ry SDS TS a er ae RAV tg Le AY FUSES h\n" +
        "Baradiya Village - Dwarka (Gujarat) - 361335\n" +
        "Token No: 45\n" +
        "Bill No: 6424",
    );
    expect(out.amount.value).toBeNull();
  });

  it("does not read a single bare digit (Component < 1) as the amount", () => {
    // Real GUJARAT FREIGHT TOOLS invoice: OCR mangled the numeric total row, so
    // the first bare candidate in document order was "1" from "Component < 1"
    // in the company header — $1.00. The comparison guard and single-digit
    // guard must skip it; the words-amount fallback below finds the real total.
    const out = extractFromText(
      "Manufacturing & Supply of Precision Press Tool & Room Component < 1\n" +
        "Tel 22223570507\nPAN : 76CURPEIFI9N TAX INVOICE\n" +
        "FOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY",
    );
    expect(out.amount.value).toBe(4490);
  });

  it("reads a total written out in words (Indian GST invoice)", () => {
    // The numeric total row OCR'd to garbage, but the words line survived:
    // "FOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY" = ₹4,490.
    const out = extractFromText(
      "Tost a Ursvers al Tol 68 Has po Soi\n" +
        "FOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY\n" +
        "SIX HUNDRED AND EIGHTY-FOUR RUPEES AND NINETY PAISA ONLY",
    );
    // Largest words-amount wins (the grand total, not a line item).
    expect(out.amount.value).toBe(4490);
  });

  it("parses paisa/cent words into a decimal amount", () => {
    expect(extractFromText("SIX HUNDRED AND EIGHTY-FOUR RUPEES AND NINETY PAISA ONLY").amount.value).toBe(684.9);
    expect(extractFromText("FIVE HUNDRED DOLLARS AND FIFTY CENTS ONLY").amount.value).toBe(500.5);
  });

  it("tolerates OCR-mangled number words in a words total", () => {
    // OCR read "FOUR" as "FOUS" — the edit-distance-1 match must recover it.
    expect(extractFromText("SIX HUNDRED AND EIGHTY-FOUS RUPEES AND NINETY PAISA ONLY").amount.value).toBe(684.9);
    // "HUNDRID" for HUNDRED, "THOUSANB" for THOUSAND (each edit distance 1).
    expect(extractFromText("TWO THOUSANB RUPEES ONLY").amount.value).toBe(2000);
    expect(extractFromText("FIVE HUNDRID RUPEES ONLY").amount.value).toBe(500);
  });

  it("parses lakh/crore words (Indian scale)", () => {
    expect(extractFromText("ONE LAKH TWENTY THOUSAND RUPEES ONLY").amount.value).toBe(120000);
  });

  it("never picks a words-amount line as the vendor", () => {
    // The words line is letter-dense ALL-CAPS — exactly what the vendor picker
    // wants — but it is the amount, never the store name.
    const out = extractFromText("GUJARAT FREIGHT TOOLS\nFOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY");
    expect(out.amount.value).toBe(4490);
    expect(out.vendor.value).toBe("GUJARAT FREIGHT TOOLS");
    const mangled = extractFromText("Vendor Line\nSIX HUNDRED AND EIGHTY-FOUS RUPEES AND NINETY PAISA ONLY");
    expect(mangled.vendor.value).toBe("Vendor Line");
  });

  it("never leaks an INR words line into the vendor", () => {
    // The amount-token strip removes the "INR" currency word; the blanked
    // line must not resurface as "TWENTY FIVE THOUSAND ONLY".
    const out = extractFromText("TWENTY FIVE THOUSAND INR ONLY");
    expect(out.amount.value).toBe(25000);
    expect(out.vendor.value).toBeNull();
  });

  it("canonicalises a mangled known vendor (edit distance 1 per word)", () => {
    // OCR read the merchant header as "GUJARAT FRlGHT TOOLS" (lowercase L for
    // uppercase I) — the known-vendor matcher must recover the canonical name.
    const out = extractFromText("GUJARAT FRlGHT TOOLS\nFOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY");
    expect(out.amount.value).toBe(4490);
    expect(out.vendor.value).toBe("Gujarat Freight Tools");
    // Single-word confusions too ("Te1stra" — digit 1 for I).
    expect(extractFromText("Te1stra\nAmount: $99.95").vendor.value).toBe("Telstra");
  });

  it("leaves an unknown or exact vendor untouched", () => {
    // Not in KNOWN_VENDORS — never rewritten.
    expect(extractFromText("wagh nd Faiate Web\nAmount: $10.00").vendor.value).toBe("wagh nd Faiate Web");
    // Exact known spelling stays canonical (already exact).
    expect(extractFromText("Reliance Hypermart Limited\nTotal Rs 321.68").vendor.value).toBe(
      "Reliance Hypermart Limited",
    );
  });

  it("canonicalises against learned vendors from logged bills", () => {
    // A merchant NOT in the seed list, learned from a previously logged bill:
    // the mangled re-read must canonicalise to the logged spelling.
    const learned = ["wagh and sons plumbing"];
    const out = extractFromText("WAGH AND SONS PLUMBINQ\nTotal $600.00", learned);
    expect(out.amount.value).toBe(600);
    expect(out.vendor.value).toBe("wagh and sons plumbing");
    // Without the learned list the same text stays as OCR'd (no known vendor).
    expect(extractFromText("WAGH AND SONS PLUMBINQ\nTotal $600.00").vendor.value).toBe("WAGH AND SONS PLUMBINQ");
  });

  it("drops vendor confidence for edit-distance canonicalisation and logs the resolution", () => {
    // Fuzzy canonicalisation: confidence 0.9 (< verbatim 1.0) and the known
    // vendor is logged in vendor_resolved_to.
    const fuzzy = extractFromText("GUJARAT FRlGHT TOOLS\nFOUR THOUSAND FOUR HUNDRED AND NINETY RUPEES ONLY");
    expect(fuzzy.vendor.value).toBe("Gujarat Freight Tools");
    expect(fuzzy.vendor.confidence).toBe(0.9);
    expect(fuzzy.vendor_resolved_to?.value).toBe("Gujarat Freight Tools");
    // Verbatim reads (unknown or exact known) keep confidence 1 and no resolution.
    const verbatim = extractFromText("Some Unknown Shop\nTotal $10.00");
    expect(verbatim.vendor.confidence).toBe(1);
    expect(verbatim.vendor_resolved_to?.value).toBeNull();
    const exact = extractFromText("Reliance Hypermart Limited\nTotal Rs 321.68");
    expect(exact.vendor.confidence).toBe(1);
    expect(exact.vendor_resolved_to?.value).toBeNull();
    // An edit clears the resolution log.
    expect(extractFromText("Some Unknown Shop\nTotal $10.00").vendor_resolved_to).toBeDefined();
  });

  it("mergeKnownVendors keeps the seed first and dedupes learned vendors", () => {
    const merged = mergeKnownVendors(["telstra", "wagh and sons plumbing", "", null, "TELSTRA", "%%% ###", "x"]);
    expect(merged[0]).toBe("Telstra"); // seed canonical casing wins
    expect(merged).toContain("wagh and sons plumbing");
    // Deduped by case-folded spelling — "telstra"/"TELSTRA" collapse into the seed entry.
    const telstraCount = merged.filter((v) => v.toLowerCase() === "telstra").length;
    expect(telstraCount).toBe(1);
    // Junk that isn't a name (symbol wall, single letter) is never learned.
    expect(merged.some((v) => v.includes("%") || v === "x")).toBe(false);
  });

  it("ignores prose lines with number words but no currency", () => {
    // "THOUSAND AND NINETY" with no RUPEES/DOLLARS word is not an amount.
    expect(extractFromText("FOUR THOUSAND AND NINETY ITEMS").amount.value).toBeNull();
  });

  it("keeps Subtotal lines from matching the fuzzy total", () => {
    const out = extractFromText("Subtotal Rs 245.00\nTotal Rs 267.30");
    expect(out.amount.value).toBe(267.3);
  });

  it("takes the full total over a truncated AMOUNT line (largest wins)", () => {
    // The fold cut the AMOUNT line in half ("Rs 32"); the full value sits on
    // the mangled TOTAL line — the largest total-line amount wins.
    const out = extractFromText("AMOUNT Rs 32\n101AL Rs 321.68");
    expect(out.amount.value).toBe(321.68);
  });

  it("returns no vendor for ABN/heading-only boilerplate", () => {
    const out = extractFromText("ABN: 51 824 753 556 Total $100.00");
    expect(out.abn.value).toBe("51 824 753 556");
    expect(out.vendor.value).toBeNull();
  });

  it("drops leftover comma-formatted amounts from the vendor", () => {
    const out = extractFromText("Supplies Total $1,234.56 officeworks");
    expect(out.vendor.value).toBe("officeworks");
  });

  it("drops invoice numbers and thank-you boilerplate", () => {
    const out = extractFromText(
      "Origin Energy\nInvoice Number: INV-2847\nThank you for your business\nTotal $245.00",
    );
    expect(out.vendor.value).toBe("Origin");
  });

  it("picks the vendor from the first clean-looking line, not every token", () => {
    // The real thermal receipt: joining every surviving OCR token produced a
    // garbage wall ("Hore nan % ed } HET LN IE …"). The merchant block at the
    // top is letter-dense and wins; the number wall and boilerplate below never
    // join in.
    const out = extractFromText(
      "RELIANCE HYPERMART LIMITED\nMADURAI IN\nDATE : 09/05/2009    TIME : 19:07:22\nMID :                TID : 40503646\nBATCH NO : 000221    INVOICE NO : 002193\nSALE\nCARD : **** **** **** 7644    SWIPE\nCARD TYPE : MASTERCARD  EXP DATE : **/**\nAPPR CODE : 021664    RRN : 000000002912\nAMOUNT    Rs            321.68\nTOTAL     Rs            321.68\n*** CUSTOMER COPY ***",
    );
    expect(out.vendor.value).toBe("RELIANCE HYPERMART LIMITED MADURAI IN"); // was the full wall
    expect(out.amount.value).toBe(321.68);
  });

  it("skips symbol garbage lines before the first clean vendor line", () => {
    // Page-top noise ("[5] Hore nan] %") must not win just because it comes
    // first — the store name on the next line is the vendor.
    const out = extractFromText("[5] Hore nan] %\nOrigin Energy\n10/08/2026\nAmount: $245.00");
    expect(out.vendor.value).toBe("Origin");
  });

  it("stops the vendor block at single-letter fragment lines", () => {
    // "wm N f" is all letters but has no real word — the block must not extend
    // past it into the number wall below.
    const out = extractFromText(
      "HET LN IE .\nwm N f\nHIE: ASIA TE: BRR\nAMOUNT    Rs            321.68\nTOTAL     Rs            321.68",
    );
    expect(out.vendor.value).toBe("HET LN IE");
  });

});

describe("extraction service pipeline", () => {
  it("classifies a regex text entry as machine-read", async () => {
    const service = createExtractionService(CONFIG);
    const outcome = await service.run({ text: "$245.00 10/08/2026 Telstra" });
    expect(outcome.source).toBe("regex");
    expect(outcome.machineRead).toBe(true);
    expect(outcome.gate).toBe("high"); // confident, but machine-read → always confirm
  });

  it("returns a low gate for empty input", async () => {
    const service = createExtractionService(CONFIG);
    const outcome = await service.run({});
    expect(outcome.gate).toBe("low");
    expect(outcome.machineRead).toBe(true);
  });

  it("parses local OCR text as an ocr-sourced machine-read extraction (no API)", async () => {
    const service = createExtractionService(CONFIG);
    const outcome = await service.run({ ocrText: "internet 99.95 telstra gst" });
    expect(outcome.source).toBe("ocr");
    expect(outcome.machineRead).toBe(true); // OCR is never auto-logged
    expect(outcome.extraction.amount.value).toBe(99.95);
    expect(outcome.extraction.vendor.value).toBe("telstra");
    expect(outcome.extraction.category_hint.value).toBe("utilities");
    expect(outcome.extraction.gst.value).toBe(10);
  });

  it("prefers OCR text over typed text in the fallback", async () => {
    const service = createExtractionService(CONFIG);
    const outcome = await service.run({ text: "wages 500 rajesh", ocrText: "rent 2200 homebase" });
    expect(outcome.source).toBe("ocr");
    expect(outcome.extraction.amount.value).toBe(2200);
    expect(outcome.extraction.vendor.value).toBe("homebase");
  });

  it("recomputes GST and validates the ABN end to end", async () => {
    const service = createExtractionService(CONFIG);
    const outcome = await service.run({ text: "Telstra $245.00 GST inclusive 51 824 753 556" });
    expect(outcome.extraction.gst.value).toBe(round2(245 / 11));
    expect(outcome.extraction.abn.value).toBe("51 824 753 556");
  });

  it("pre-fills category_hint from injected vendor history when the text has no keyword match", async () => {
    const service = createExtractionService(CONFIG);
    const history = new Map<string, VendorCategorySuggestion>([
      ["ACME CORP", { category: "rent", confidence: 0.9, sampleSize: 5 }],
    ]);
    const outcome = await service.run({ text: "$245.00 10/08/2026 Acme Corp", vendorCategoryHistory: history });
    expect(outcome.extraction.vendor.value).toBe("Acme Corp");
    expect(outcome.extraction.category_hint.value).toBe("rent");
  });

  it("never overrides a category the text itself already matched (regex keyword outranks history)", async () => {
    const service = createExtractionService(CONFIG);
    const history = new Map<string, VendorCategorySuggestion>([
      ["HOMEBASE", { category: "misc", confidence: 0.95, sampleSize: 10 }],
    ]);
    const outcome = await service.run({ text: "rent 2200 homebase", vendorCategoryHistory: history });
    expect(outcome.extraction.category_hint.value).toBe("rent");
  });
});

describe("fillCategoryHint (procedural layer — episodic > semantic > untouched)", () => {
  function ext(overrides: Partial<BillExtraction> = {}): BillExtraction {
    return extraction({ category_hint: { value: null, confidence: 0 }, ...overrides });
  }

  it("does nothing when the bill's own extraction already has a category", () => {
    const withHint = ext({ category_hint: { value: "rent", confidence: 0.8 } });
    const result = fillCategoryHint(withHint, new Map([["TELSTRA", { category: "misc", confidence: 1, sampleSize: 9 }]]));
    expect(result.category_hint.value).toBe("rent");
  });

  it("fills from episodic history when the vendor matches (case/spacing-insensitive)", () => {
    const history = new Map<string, VendorCategorySuggestion>([
      ["ORIGIN ENERGY", { category: "utilities", confidence: 0.8, sampleSize: 4 }],
    ]);
    const result = fillCategoryHint(ext({ vendor: { value: "origin  energy", confidence: 0.9 } }), history);
    expect(result.category_hint).toEqual({ value: "utilities", confidence: 0.8 });
  });

  it("falls back to the semantic dictionary when there's no episodic history for the vendor", () => {
    const result = fillCategoryHint(ext({ vendor: { value: "Bunnings", confidence: 0.9 } }), new Map());
    expect(result.category_hint.value).toBe("inventory");
  });

  it("prefers episodic history over the semantic dictionary for the same vendor", () => {
    const history = new Map<string, VendorCategorySuggestion>([
      ["BUNNINGS", { category: "misc", confidence: 0.75, sampleSize: 3 }],
    ]);
    const result = fillCategoryHint(ext({ vendor: { value: "Bunnings", confidence: 0.9 } }), history);
    expect(result.category_hint.value).toBe("misc");
  });

  it("leaves category_hint null when neither source has anything for the vendor", () => {
    const result = fillCategoryHint(ext({ vendor: { value: "Some Random Cafe", confidence: 0.9 } }), new Map());
    expect(result.category_hint.value).toBeNull();
  });

  it("leaves category_hint null when there's no vendor to look up", () => {
    const result = fillCategoryHint(ext({ vendor: { value: null, confidence: 0 } }), new Map());
    expect(result.category_hint.value).toBeNull();
  });
});

describe("extraction pipeline — Workers AI fallback (env.AI)", () => {
  // Regex cannot find the amount here: the only number sits on a total-like
  // line with a trailing slash, which the bare-number guard skips. The digits
  // ARE in the text, so the anti-fabrication guard keeps a real AI reading.
  const AI_READABLE_OCR = "RELIANCE HYPERMART LIMITED DATE 09/05/2009 TOTAL 321.68/- CUSTOMER COPY";
  // No digits at all — an AI that reports an amount/date here is fabricating.
  const UNPARSEABLE_OCR = "HDFC BANK RELIANCE HYPERMART LIMITED MADURAI IN SALE CARD SWIPE";

  function fakeAi(response: unknown, onRun?: (model: string, inputs: Record<string, unknown>) => void): WorkersAi {
    return {
      async run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
        onRun?.(model, inputs);
        if (response instanceof Error) throw response;
        return response;
      },
    };
  }

  const GOOD_JSON = JSON.stringify({
    amount: 321.68,
    vendor: "Reliance Hypermart",
    date: "09/05/2009",
    abn: null,
    gst: null,
    gst_basis: "none",
    category: "misc",
    invoice_number: null,
    due_date: null,
    confidence: "high",
  });

  it("runs Workers AI on OCR text when regex cannot find the amount", async () => {
    let seen: { model: string; maxTokens: number; temperature: number; prompt: string } | undefined;
    const ai = fakeAi({ response: GOOD_JSON }, (model, inputs) => {
      seen = {
        model,
        maxTokens: inputs.max_tokens as number,
        temperature: inputs.temperature as number,
        prompt: inputs.prompt as string,
      };
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: AI_READABLE_OCR });

    expect(outcome.source).toBe("ai");
    expect(outcome.machineRead).toBe(false); // trusted parser — High AI reads auto-log (§5.8)
    expect(outcome.extraction.amount.value).toBe(321.68);
    expect(outcome.extraction.vendor.value).toBe("Reliance Hypermart");
    expect(outcome.extraction.date.value).toBe("2009-05-09"); // DD/MM/YYYY → ISO
    expect(outcome.gate).toBe("high");

    // The env.AI call is the configured text model with the §5.3 constraints.
    expect(seen?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(seen?.maxTokens).toBe(256);
    expect(seen?.temperature).toBe(0.1);
    expect(seen?.prompt).toContain(AI_READABLE_OCR);
  });

  it("nulls an AI amount/date that is not present in the OCR text (anti-fabrication)", async () => {
    // Live finding: llama-3.3-70b invented $1,234.56 / 2023-02-27 from OCR text
    // with no numbers at all. The guard nulls fields whose digits do not
    // literally appear, so the gate drops to Low → manual entry prompt.
    const ai = fakeAi({ response: GOOD_JSON });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: UNPARSEABLE_OCR });
    expect(outcome.source).toBe("ai");
    expect(outcome.extraction.amount.value).toBeNull();
    expect(outcome.extraction.date.value).toBeNull();
    expect(outcome.extraction.vendor.value).toBe("Reliance Hypermart"); // still kept
    expect(outcome.gate).toBe("low"); // fabricated amount → manual entry
  });

  it("parses JSON wrapped in code fences", async () => {
    const ai = fakeAi({ response: "```json\n" + GOOD_JSON + "\n```" });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: AI_READABLE_OCR });
    expect(outcome.source).toBe("ai");
    expect(outcome.extraction.amount.value).toBe(321.68);
  });

  it("keeps the regex result when Workers AI returns garbage", async () => {
    const ai = fakeAi({ response: "sorry, here is some prose about the bill" });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: UNPARSEABLE_OCR });
    expect(outcome.source).toBe("ocr"); // garbage → same as a regex failure
    expect(outcome.extraction.amount.value).toBeNull();
    expect(outcome.gate).toBe("low"); // → manual entry prompt
  });

  it("keeps the regex result when the AI binding throws", async () => {
    const ai = fakeAi(new Error("binding not configured"));
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: UNPARSEABLE_OCR });
    expect(outcome.source).toBe("ocr");
    expect(outcome.extraction.amount.value).toBeNull();
  });

  it("never calls Workers AI when regex already found the amount", async () => {
    let called = false;
    const ai = fakeAi(new Error("should not be called"), () => {
      called = true;
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: "internet 99.95 telstra gst" });
    expect(called).toBe(false);
    expect(outcome.source).toBe("ocr");
    expect(outcome.extraction.amount.value).toBe(99.95);
  });

  it("never sends typed manual entries to Workers AI", async () => {
    let called = false;
    const ai = fakeAi(new Error("should not be called"), () => {
      called = true;
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ text: "wages 500 rajesh" });
    expect(called).toBe(false);
    expect(outcome.source).toBe("regex");
    expect(outcome.extraction.amount.value).toBe(500);
  });

  it("reads photo bytes with the vision model when no OCR text exists", async () => {
    // The real WhatsApp webhook path passes image bytes only (no server-side
    // OCR) — the vision model reads the bytes directly, so the photo no
    // longer falls through to the manual-entry prompt.
    let seen: { model: string; content: Array<Record<string, unknown>> } | undefined;
    const ai = fakeAi({ response: GOOD_JSON }, (model, inputs) => {
      const messages = inputs.messages as Array<{ content: Array<Record<string, unknown>> }>;
      seen = { model, content: messages[0]!.content };
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({
      imageBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      imageMimeType: "image/jpeg",
    });
    expect(outcome.source).toBe("ai");
    expect(outcome.machineRead).toBe(false); // trusted parser — auto-log eligible (§5.8)
    expect(outcome.extraction.amount.value).toBe(321.68);
    expect(outcome.gate).toBe("high");
    // Chat-message input: a base64 data URI inside an image_url content block.
    expect(seen?.model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    const textBlock = seen?.content.find((c) => c.type === "text");
    const imageBlock = seen?.content.find((c) => c.type === "image_url") as
      | { image_url: { url: string } }
      | undefined;
    expect(textBlock?.text).toContain("photo of a bill");
    expect(imageBlock?.image_url.url).toBe(
      `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")}`,
    );
  });

  it("parses a `description`-wrapped response with Markdown-escaped underscores", async () => {
    // Live finding (against the earlier LLaVA vision model, kept as a
    // regression case): a vision model wrapping the JSON in a `description`
    // string and escaping key underscores as `\_` (invalid JSON) — both
    // handled before parsing, regardless of which model returns this shape.
    const ai = fakeAi({
      description: JSON.stringify({
        amount: 327.66,
        vendor: "HDFC Bank",
        date: "03/03/2009",
        gst_basis: "inclusive",
        confidence: "high",
      }).replace(/_/g, "\\_"),
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({
      imageBytes: new Uint8Array([1, 2, 3]),
      imageMimeType: "image/jpeg",
    });
    expect(outcome.source).toBe("ai");
    expect(outcome.extraction.amount.value).toBe(327.66);
    expect(outcome.extraction.vendor.value).toBe("HDFC Bank");
    expect(outcome.gate).toBe("high");
  });

  it("falls back to manual entry when the vision model fails on photo bytes", async () => {
    const ai = fakeAi(new Error("vision binding failed"));
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ imageBytes: new Uint8Array([1, 2, 3]) });
    expect(outcome.source).toBe("none");
    expect(outcome.gate).toBe("low"); // → manual-entry prompt
    expect(outcome.extraction.amount.value).toBeNull();
  });

  it("does not call the vision model when OCR text is present", async () => {
    let called = false;
    const ai = fakeAi(new Error("should not be called"), () => {
      called = true;
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({
      ocrText: "internet 99.95 telstra gst",
      imageBytes: new Uint8Array([1, 2, 3]),
    });
    expect(called).toBe(false);
    expect(outcome.source).toBe("ocr");
    expect(outcome.extraction.amount.value).toBe(99.95);
  });

  // Real VRAJ RESTAURANT receipt: garbage OCR left a bill/token reference
  // number ("6424") as the only clean digit run, so regex "found" it as the
  // amount — a wrong but non-null guess the old code trusted outright.
  const GARBAGE_OCR = "Ey ral RO 3h ry SDS TS a er ae RAV tg Le AY FUSES h RE Cashier he BING, 6424 mies";

  const VISION_JSON = JSON.stringify({
    amount: 1249,
    vendor: "Vraj Restaurant",
    date: "28/12/2024",
    abn: null,
    gst: null,
    gst_basis: "none",
    category: "misc",
    invoice_number: null,
    due_date: null,
    confidence: "high",
  });

  it("escalates to the vision model when OCR text is garbage, overriding the regex guess", async () => {
    let visionCalled = false;
    const ai = fakeAi({ response: VISION_JSON }, (model) => {
      if (model === "@cf/meta/llama-4-scout-17b-16e-instruct") visionCalled = true;
    });
    const service = createExtractionService(CONFIG, ai);
    // Sanity check: regex alone really does pick the wrong reference number.
    expect(extractFromText(GARBAGE_OCR).amount.value).toBe(6424);

    const outcome = await service.run({
      ocrText: GARBAGE_OCR,
      imageBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      imageMimeType: "image/jpeg",
    });
    expect(visionCalled).toBe(true);
    expect(outcome.source).toBe("ai");
    expect(outcome.machineRead).toBe(false); // trusted parser — auto-log eligible (§5.8)
    expect(outcome.extraction.amount.value).toBe(1249);
    expect(outcome.extraction.vendor.value).toBe("Vraj Restaurant");
  });

  it("keeps the regex guess when OCR text is garbage but no image bytes exist", async () => {
    let called = false;
    const ai = fakeAi({ response: VISION_JSON }, () => {
      called = true;
    });
    const service = createExtractionService(CONFIG, ai);
    const outcome = await service.run({ ocrText: GARBAGE_OCR });
    expect(called).toBe(false); // no bytes to show the vision model
    expect(outcome.source).toBe("ocr");
    expect(outcome.extraction.amount.value).toBe(6424); // still wrong, but nothing better available
  });
});
