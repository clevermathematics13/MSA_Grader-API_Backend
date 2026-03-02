/***************
 * MSA_Config.gs
 ***************/

// === REQUIRED ===
// Where all markscheme folders live in Drive:
const MSA_PARENT_FOLDER_ID = "1GDGql-mIeH2YoD1OfnFa0UhxUdaXsY4D";

// Folder where OCR JSON outputs are stored (use same parent folder by default).
const MSA_OCR_JSON_OUTPUT_FOLDER_ID = MSA_PARENT_FOLDER_ID;

// Rules spreadsheet (you already have this):
const MSA_GRADING_RULES_SPREADSHEET_ID = "1lrgFrwEpHhT6Cenfsj8dQ5VeseNa_V8RLWyQabBt1n4";
const MSA_GRADING_RULES_SHEET_NAME = "rules";

// Optional: question metadata sheet used to skip autograde on parts with "graph/draw" command terms.
// If you don’t use it yet, leave it on; code fails soft (logs + continues).
const MSA_QUESTION_META_SPREADSHEET_ID = "1fc7cWtM83oxQ8rMIX8F_sgjN1xCkLpqdbeTzIG33kPU";
const MSA_QUESTION_META_SHEET_NAME = "Sheet1"; // change if needed
// OCR Corrections learning sheet — leave empty to auto-create on first Save.
// After first save, the ID will be logged and stored in Script Properties.
const MSA_OCR_CORRECTIONS_SPREADSHEET_ID = "";

// Minimum frequency before a learned correction is auto-applied
// 1 = apply after first correction, 2 = require two sightings, etc.
const MSA_OCR_LEARN_MIN_FREQUENCY = 1;

// ── Per-Student OCR Profiles (writer-adaptive corrections) ──
// Leave empty to auto-create on first save.
const MSA_STUDENT_PROFILES_SPREADSHEET_ID = "";

// Minimum frequency for a student-level rule to auto-apply.
// Lower than the global threshold: student patterns are more targeted.
const MSA_STUDENT_OCR_MIN_FREQUENCY = 1;

// Maximum Levenshtein distance for fuzzy matching (0 = exact only, 1-2 = forgiving)
const MSA_STUDENT_OCR_FUZZY_DISTANCE = 0;
// If a part’s command term is one of these, mark points with skip_autograde=true
const MSA_SKIP_AUTOGRADE_COMMAND_TERMS = ["graph", "draw"];

// === OUTPUT FILENAMES inside each markscheme folder ===
const MSA_FN_SOURCE_DOC_ID = "source_doc_id.txt";
const MSA_FN_SOURCE_PDF = "markscheme_source.pdf";

const MSA_FN_OCR_COMBINED = "markscheme_ocr_combined.txt";
const MSA_FN_PREVIEW_HTML = "markscheme_preview.html";
const MSA_FN_PREVIEW_PNG = "markscheme_preview.png";

const MSA_FN_POINTS_PASS1_JSON = "markscheme_points.json";
const MSA_FN_POINTS_PASS1_READABLE = "markscheme_points_readable.txt";

const MSA_FN_POINTS_PASS2_JSON = "markscheme_points_pass2.json";
const MSA_FN_POINTS_PASS2_READABLE = "markscheme_points_pass2_readable.txt";

const MSA_FN_POINTS_PASS3_JSON = "markscheme_points_pass3.json";
const MSA_FN_POINTS_PASS3_READABLE = "markscheme_points_pass3_readable.txt";

const MSA_FN_POINTS_BEST_JSON = "markscheme_points_best.json";
const MSA_FN_POINTS_BEST_READABLE = "markscheme_points_best_readable.txt";

const MSA_FN_VALIDATION_REPORT = "markscheme_validation_report.txt";

// Mathpix request formats (we mostly rely on .text right now)
const MSA_MATHPIX_FORMATS = ["text", "latex_styled", "data"];

// Image extraction filters
const MSA_MIN_IMAGE_BYTES = 20 * 1024; // ignore tiny inline icons / tiny equation images

// Pass2 trigger thresholds
const MSA_PASS2_TRIGGER_MIN_COVERAGE_RATIO = 0.70;
const MSA_PASS2_TRIGGER_MIN_STRUCTURE_SCORE = 0.85;

// If true, remove stale outputs each run so the folder reflects latest truth.
const MSA_CLEAN_STALE_OUTPUTS_EACH_RUN = true;

// If true, generate MathJax preview HTML
const MSA_CREATE_PREVIEW_HTML = true;

// If true, create preview.png (largest image blob)
const MSA_CREATE_PREVIEW_PNG = true;

// Entry-point name shown in reports/logs
const MSA_PROCESS_NAME = "Markscheme Atomization (MSA)";

// Default rules if sheet is missing/blank (sheet overrides these)
function msaDefaultRules_() {
  return [
    {
      rule_key: "drop_totals",
      enabled: true,
      pattern: "^\\s*(Totals\\s*\\[.*\\]|\\[.*marks\\]|\\(AG\\)|AG|Total\\s*\\[.*\\])\\s*$",
      action: "DROP_LINE",
      notes: "Remove trailing totals/headers that confuse structure"
    },
    {
      rule_key: "split_award_numerator_denominator",
      enabled: true,
      pattern: "Award A1 for a correct numerator and A1 for a correct denominator",
      action: "SPLIT_A1A1_USING_NOTE",
      notes: "Use note text to split A1A1"
    },
    {
      rule_key: "split_award_first_second_term",
      enabled: true,
      pattern: "Award A1 for a correct first term in the numerator and A1 for a correct second term in the numerator",
      action: "SPLIT_A1A1_USING_NOTE",
      notes: "Use note text to split A1A1"
    },
    {
      rule_key: "attach_nearest_math_context",
      enabled: true,
      pattern: ".*",
      action: "ATTACH_NEAREST_MATH_CONTEXT",
      notes: "When splitting A1s, keep nearby displayed equation as context"
    },
    {
      rule_key: "then_capture_final_value",
      enabled: true,
      pattern: "^\\s*THEN\\s*$",
      action: "CAPTURE_FINAL_RESULT_AFTER_THEN",
      notes: "Attach final evaluated value (e.g. -1/4) to THEN A1"
    },
    {
      rule_key: "cleanup_stale_artifacts",
      enabled: true,
      pattern: ".*",
      action: "CLEAN_FOLDER_STALE_OUTPUTS",
      notes: "Delete old outputs so folder reflects latest truth"
    }
  ];
}
