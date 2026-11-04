export interface Book {
  book_id: string;
  title: string;
  copies: number;
  available: number;
}

export interface Loan {
  loan_id: string;
  book_id: string;
  patron_id: string;
  status: "on_loan" | "returned";
  renewals: number;
}

export interface Hold {
  hold_id: string;
  book_id: string;
  patron_id: string;
}

export interface LibrarySnapshot {
  books: Book[];
  loans: Loan[];
  holds: Hold[];
}

export interface SeedLoan {
  loan_id: string;
  book_id: string;
  patron_id: string;
  renewals: number;
}

export type LibraryFailure =
  | { error: "not_found"; message: string }
  | { error: "invalid_request"; message: string }
  | { error: "conflict"; message: string };

export type LibraryResult<T> = { ok: true; value: T } | { ok: false; failure: LibraryFailure };

const CATALOG: readonly { book_id: string; title: string; copies: number }[] = [
  { book_id: "BK-OWL", title: "Field Guide to Owls", copies: 1 },
  { book_id: "BK-RARE", title: "Atlas of Lost Rivers", copies: 1 },
  { book_id: "BK-POEM", title: "Pocket Poems", copies: 3 },
];

export class LibraryDesk {
  private loans: Loan[] = [];
  private holds: Hold[] = [];
  private nextHold = 1;

  reset(): LibrarySnapshot {
    this.loans = [];
    this.holds = [];
    this.nextHold = 1;
    return this.snapshot();
  }

  snapshot(): LibrarySnapshot {
    return {
      books: CATALOG.map((book) => ({
        ...book,
        available: book.copies - this.loans.filter((loan) => loan.book_id === book.book_id && loan.status === "on_loan").length,
      })),
      loans: this.loans.map((loan) => ({ ...loan })),
      holds: this.holds.map((hold) => ({ ...hold })),
    };
  }

  seed(loans: readonly SeedLoan[]): LibraryResult<LibrarySnapshot> {
    const next: Loan[] = [];
    const seen = new Set<string>();
    for (const loan of loans) {
      if (seen.has(loan.loan_id)) {
        return { ok: false, failure: { error: "invalid_request", message: `Duplicate loan ${loan.loan_id}.` } };
      }
      if (!CATALOG.some((book) => book.book_id === loan.book_id)) {
        return { ok: false, failure: { error: "not_found", message: `Unknown book ${loan.book_id}.` } };
      }
      seen.add(loan.loan_id);
      next.push({ ...loan, status: "on_loan" });
    }
    this.loans = next;
    this.holds = [];
    this.nextHold = 1;
    return { ok: true, value: this.snapshot() };
  }

  getLoan(loanId: string): LibraryResult<Loan> {
    const loan = this.loans.find((entry) => entry.loan_id === loanId);
    if (!loan) return { ok: false, failure: { error: "not_found", message: `Unknown loan ${loanId}.` } };
    return { ok: true, value: { ...loan } };
  }

  renew(loanId: string): LibraryResult<Loan> {
    const loan = this.loans.find((entry) => entry.loan_id === loanId);
    if (!loan) return { ok: false, failure: { error: "not_found", message: `Unknown loan ${loanId}.` } };
    if (loan.status !== "on_loan") {
      return { ok: false, failure: { error: "conflict", message: `Loan ${loanId} is ${loan.status}.` } };
    }
    loan.renewals += 1;
    return { ok: true, value: { ...loan } };
  }

  returnLoan(loanId: string): LibraryResult<Loan> {
    const loan = this.loans.find((entry) => entry.loan_id === loanId);
    if (!loan) return { ok: false, failure: { error: "not_found", message: `Unknown loan ${loanId}.` } };
    if (loan.status !== "on_loan") {
      return { ok: false, failure: { error: "conflict", message: `Loan ${loanId} is ${loan.status}.` } };
    }
    loan.status = "returned";
    return { ok: true, value: { ...loan } };
  }

  placeHold(bookId: string, patronId: string): LibraryResult<Hold> {
    const book = this.snapshot().books.find((entry) => entry.book_id === bookId);
    if (!book) return { ok: false, failure: { error: "not_found", message: `Unknown book ${bookId}.` } };
    if (book.available > 0) {
      return { ok: false, failure: { error: "conflict", message: `${bookId} still has a copy on the shelf.` } };
    }
    if (this.holds.some((hold) => hold.book_id === bookId && hold.patron_id === patronId)) {
      return { ok: false, failure: { error: "conflict", message: `${patronId} already holds ${bookId}.` } };
    }
    const hold: Hold = { hold_id: `hold_${String(this.nextHold).padStart(4, "0")}`, book_id: bookId, patron_id: patronId };
    this.nextHold += 1;
    this.holds.push(hold);
    return { ok: true, value: { ...hold } };
  }
}
