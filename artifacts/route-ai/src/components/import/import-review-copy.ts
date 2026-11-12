export type ImportReviewLanguage = "sv" | "en";

export type ImportReviewCopy = {
  filters: {
    problems: string;
    all: string;
    ready: string;
    rejected: string;
  };
  status: {
    ready: string;
    action: string;
    awaitingAddress: string;
  };
  count: {
    rows: string;
    awaitingAddress: string;
  };
  validation: {
    addressMissing: string;
    dateMissing: string;
    negativeWeight: string;
    negativeVolume: string;
    invalidTimeWindow: string;
  };
  review: {
    filterLabel: string;
    problemsDescription: string;
    allDescription: string;
    readyDescription: string;
    rejectedFilterDescription: string;
    noProblems: string;
    noRows: string;
    noRejectedRows: string;
    rejectedHeading: string;
    rejectedDescription: string;
    sourceRow: string;
    exportReason: string;
    exportOriginalValues: string;
    exportAction: string;
    addressAwaiting: string;
    addressAwaitingDescription: string;
    addressProblems: string;
  };
};

const SWEDISH_COPY: ImportReviewCopy = {
  filters: {
    problems: "Problem",
    all: "Alla",
    ready: "Redo",
    rejected: "Avvisade",
  },
  status: {
    ready: "Redo",
    action: "Åtgärd krävs",
    awaitingAddress: "Adress behöver bekräftas",
  },
  count: {
    rows: "rader",
    awaitingAddress: "väntar på adress",
  },
  validation: {
    addressMissing: "Leveransadress saknas.",
    dateMissing: "Datum saknas.",
    negativeWeight: "Vikten får inte vara negativ.",
    negativeVolume: "Volymen får inte vara negativ.",
    invalidTimeWindow: "Tidsfönstrets sluttid måste vara efter starttiden.",
  },
  review: {
    filterLabel: "Visa",
    problemsDescription: "Rader som behöver åtgärdas först.",
    allDescription: "Alla importerade rader.",
    readyDescription: "Rader som klarar valideringen.",
    rejectedFilterDescription: "Rader som har avvisats och inte sparas.",
    noProblems: "Inga problem hittades.",
    noRows: "Inga rader.",
    noRejectedRows: "Inga avvisade rader.",
    rejectedHeading: "Avvisade rader",
    rejectedDescription: "Varje källrad visas en gång med en konkret orsak.",
    sourceRow: "Källrad",
    exportReason: "Orsak",
    exportOriginalValues: "Originalvärden",
    exportAction: "Exportera",
    addressAwaiting: "Giltig rad – adress behöver bekräftas",
    addressAwaitingDescription: "Välj en adresskandidat eller sök igen. Raden sparas inte förrän leverans och eventuell pickup har giltiga koordinater.",
    addressProblems: "Adressen behöver åtgärdas",
  },
};

const ENGLISH_COPY: ImportReviewCopy = {
  filters: {
    problems: "Problems",
    all: "All",
    ready: "Ready",
    rejected: "Rejected",
  },
  status: {
    ready: "Ready",
    action: "Action needed",
    awaitingAddress: "Address needs confirmation",
  },
  count: {
    rows: "rows",
    awaitingAddress: "awaiting address",
  },
  validation: {
    addressMissing: "Delivery address is required.",
    dateMissing: "Date is required.",
    negativeWeight: "Weight cannot be negative.",
    negativeVolume: "Volume cannot be negative.",
    invalidTimeWindow: "The time-window end must be after the start.",
  },
  review: {
    filterLabel: "Show",
    problemsDescription: "Rows that need attention first.",
    allDescription: "All imported rows.",
    readyDescription: "Rows that pass validation.",
    rejectedFilterDescription: "Rows rejected and excluded from saving.",
    noProblems: "No problems found.",
    noRows: "No rows.",
    noRejectedRows: "No rejected rows.",
    rejectedHeading: "Rejected rows",
    rejectedDescription: "Each source row is shown once with a concrete reason.",
    sourceRow: "Source row",
    exportReason: "Reason",
    exportOriginalValues: "Original values",
    exportAction: "Export",
    addressAwaiting: "Valid row — address needs confirmation",
    addressAwaitingDescription: "Choose an address candidate or search again. The row cannot be saved until delivery and any pickup have valid coordinates.",
    addressProblems: "Address needs attention",
  },
};

/**
 * Import review is deliberately kept out of the shared locale JSON files.
 * The import surface is often edited independently from the rest of the
 * application, and a local copy keeps Swedish and English changes atomic.
 */
export function getImportReviewCopy(language?: string): ImportReviewCopy {
  return language?.toLowerCase().startsWith("en") ? ENGLISH_COPY : SWEDISH_COPY;
}