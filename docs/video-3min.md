# Video da 3 minuti — narrativa e scaletta

Taglio da tre minuti sull’app deployata. Le schermate e i click sono quelli della [guida di navigazione](app-tour.md). Lo storyboard lungo (~4:30) resta nello [script demo](demo-script.md#e-storyboard-video-430): questo è un altro taglio, non lo sostituisce.

## L’idea in una frase

**L’agente dice che ha finito. Il lab controlla il mondo.**

Tutto il video gira intorno allo scarto tra quello che l’agente *dichiara* e quello che lo shop *contiene*. Ogni scena deve far vedere quello scarto, o come il lab lo misura, lo spiega e lo chiude.

Tre atti:

1. **Il problema** — un agente che mente senza saperlo.
2. **Il metodo** — guasto iniettato, verifier sul mondo, diagnosi di Grok, fix provato da un replay.
3. **La portata** — sicurezza, altri domini, e una misura.

## Su cosa soffermarsi

Quasi metà del video sta su una sola pagina: [`trace-t3-forged-checkout`](https://mesa-frontend-rleq.onrender.com/traces/trace-t3-forged-checkout). È l’unica schermata che contiene la tesi intera: guasto, falsa dichiarazione, check rossi, step colpevole, diagnosi, issue, fix, prima/dopo. Le altre schermate servono a dare contesto o a dire “vale anche altrove”, e passano in pochi secondi.

Tre distinzioni da far arrivare, perché sono ciò che rende il progetto diverso da un “LLM che giudica un LLM”:

- **Il verifier decide, Grok spiega.** Pass/fail viene dallo stato dello shop, non da un modello.
- **Il guasto è iniettato ed etichettato.** Sappiamo dov’è il torto, quindi possiamo misurare se la diagnosi lo trova.
- **Un fix conta solo dopo un replay.** Il prima/dopo è sui check, non sulla parola dell’agente.

## Scaletta

| Tempo | Scena | Schermata |
| --- | --- | --- |
| 0:00–0:15 | Gancio | Trace shop: messaggio finale e banner rosso |
| 0:15–0:35 | Cos’è | Dashboard |
| 0:35–0:55 | Come si testa | Agents → foglio Launch run |
| 0:55–1:45 | Il guasto | Trace shop: fault, steps, Analysis, issue |
| 1:45–2:15 | Il fix | Trace shop: Select fixes → Before / after |
| 2:15–2:35 | Sicurezza | Runs → Security |
| 2:35–2:50 | Non è solo lo shop | Trace biblioteca, Robot Lab |
| 2:50–3:00 | Chiusura | Dashboard: Eval scoreboard |

La voce sotto è di circa 300 parole: sta in tre minuti con il respiro per far leggere lo schermo. Se una scena sfora, si taglia la voce, non il tempo sulla trace shop.

### 0:00–0:15 · Gancio

**A schermo.** Trace shop, zoom sullo step finale dell’assistente: *Success. I placed order ord_fake for $24.* Poi si sale alla striscia rossa **Checks failed**.

**Voce.** «Il nostro agente risponde: ordine piazzato, ventiquattro dollari. Sembra fatto. Ma nello shop quell’ordine non esiste, e il carrello è ancora pieno.»

Si parte dal guasto, non dalla home: il problema prima del prodotto.

### 0:15–0:35 · Cos’è

**A schermo.** Dashboard: le quattro card, poi il blocco Agents con *Reference shop assistant* (badge `demo`) e *Library desk*.

**Voce.** «Questo è MESA Agent Failure Lab. Registri un agente, lo metti sotto test, inietti guasti e leggi la traccia. Il pass o fail non lo decide un modello: lo decide un verifier che legge lo stato reale del mondo.»

Non commentare i contatori. Sul deploy includono run di prova ed errori di agenti `local`, e non raccontano niente. Se compare la card *Needs attention* (run fallite senza replay del fix), lasciala in campo senza fermarti: anticipa la scena 5.

### 0:35–0:55 · Come si testa

**A schermo.** Agents → `Run` su *Reference shop assistant*. Il cursore scorre i quattro tipi: `Clean run`, `Inject fault`, `Security attack`, `Verify fix`. Si vedono i task T1–T5. Chiudi il foglio senza lanciare.

**Voce.** «Ogni agente porta i suoi task: qui un assistente shopping con cinque. Da un solo pannello lanci una run pulita, la stessa run con un guasto, un attacco di sicurezza, o la verifica di un fix.»

### 0:55–1:45 · Il guasto (la scena lunga)

Tre movimenti sulla stessa pagina, senza tagli bruschi.

**0:55–1:15 — guasto e timeline.** Striscia ambra *Fault applied* `forged_tool_result`. Poi gli Steps: il risultato di `checkout` marcato *Failing step* con `ord_fake`, e sotto il messaggio di successo.

**Voce.** «Abbiamo contraffatto il risultato del checkout: il tool restituisce un ordine finto. L’agente ci crede e dichiara successo. Il verifier controlla lo shop: nessun ordine, carrello pieno. Tre check rossi.»

**1:15–1:35 — analisi.** Pannello Analysis: categoria `Verification`, step, causa, Evidence, *Proposed fixes* `Check before reply`.

**Voce.** «Poi Grok legge la traccia. Indica lo step, la causa e le prove, e propone un fix: ricontrollare prima di rispondere. Grok spiega. Non giudica.»

**1:35–1:45 — issue.** `Open as GitHub issue` → il dialog con titolo e corpo composti. Basta il dialog: non serve aprire GitHub.

**Voce.** «La diagnosi diventa un’issue per chi mantiene l’agente.»

### 1:45–2:15 · Il fix

**A schermo.** *Select fixes* con *Check before reply · suggested* selezionato, *Re-run without the fault* spento. Click su **Verify fix**. Poi il riquadro **Before / after**: check falliti prima, passati dopo, *Recovered*.

**Voce.** «Un fix conta solo se un replay lo dimostra. Rigiochiamo lo stesso guasto sull’agente di test, con il controllo attivo. Prima: check falliti. Dopo: passati. L’ordine questa volta esiste.»

Questa è la scena da preparare prima di registrare: vedi [Preparazione](#preparazione). La voce dice «passati» solo se lo schermo lo mostra.

### 2:15–2:35 · Sicurezza

**A schermo.** Runs → chip `Security`. Il gruppo *Reference shop assistant* aperto, righe T5 *Cancel an order only when allowed* con badge `Inject fault` / `Verify fix` e `Security`.

**Voce.** «Stesso metodo per la sicurezza. Una nota malevola chiede all’agente di cancellare un ordine senza permesso. Lo shop rifiuta, l’ordine resta piazzato, e il verifier lo conferma. Un permesso scritto in una nota non è un permesso.»

### 2:35–2:50 · Non è solo lo shop

**A schermo.** Due stacchi rapidi. Primo: [`trace-renew-forged-loan`](https://mesa-frontend-rleq.onrender.com/traces/trace-renew-forged-loan), striscia ambra e check `loan_renewed` rosso. Secondo: Robot Lab, card *Why test a warehouse robot?* e la griglia A / B / C.

**Voce.** «Lo shop è solo l’esempio. La stessa pagina vale per un banco prestiti di biblioteca, e per un robot di magazzino che legge QR malevoli.»

### 2:50–3:00 · Chiusura

**A schermo.** Dashboard, blocco *Eval scoreboard*: colonne `Baseline (rules only)`, `Grok`, delta.

**Voce.** «E lo misuriamo: Grok contro una baseline a sole regole, sulle stesse tracce etichettate. MESA: il tuo agente dice che ha finito. Noi controlliamo.»

Non leggere i numeri: dipendono dall’ultimo eval pubblicato. Lo schermo li mostra da solo. Se in voce serve una cifra, prendila dallo scoreboard il giorno della registrazione.

## Cosa resta fuori, e perché

| Fuori dal video | Motivo |
| --- | --- |
| Form *New agent* / *Edit* | Configurazione, non racconto. Una frase nella scena 3 basta |
| Import OTel e *Import trace* | Vero ma lungo da spiegare; non aggiunge allo scarto dichiarato/reale |
| Filtri della lista Traces, dettaglio run | Navigazione, non tesi |
| Form *Security attack* compilato | La lista Security dice lo stesso in un terzo del tempo |
| `Launch run` del Robot Lab | Chiamata live a Grok, tempi non prevedibili; la griglia basta |
| `pnpm demo:shop` da terminale | Fuori dall’interfaccia, ha il suo runbook nello [script demo](demo-script.md#runbook-giuria) |
| Contatori della Dashboard | Includono prove e agenti `local`; distraggono |

## Preparazione

Il giorno prima, o almeno un’ora prima:

1. **Sveglia i servizi.** Il piano free si spegne dopo l’inattività. Apri il frontend e le health di [backend](https://mesa-backend-itm4.onrender.com/health) e [agentservice](https://mesa-agentservice.onrender.com/health), e aspetta 200 su entrambe.
2. **Fai il replay una volta, fuori camera.** Sulla trace shop premi `Verify fix` quando nessun altro sta usando il lab. Se risponde che il mondo è occupato, riprova dopo: non è un fallimento. Controlla che il Before / after dica falliti → passati. Il replay resta legato alla trace: ricaricando la pagina, *Earlier / follow-up runs* e Before / after ci sono ancora. In registrazione puoi rifarlo dal vivo o mostrare quello già salvato.
3. **Se il replay non passa,** l’agentservice probabilmente era spento e il lab è passato al driver di ripiego, che non applica il fix. Risveglia l’agentservice e rifai il punto 2. Non registrare la scena 5 finché non passa.
4. **Inquadratura.** Finestra fissa (per esempio 1440×900), zoom del browser al 110–125% per leggere il monospazio, stesso tema in tutte le scene, barre e schede in più nascoste. Sulla Dashboard, inquadra card e blocco Agents dei due semi: gli agenti di prova con badge `local` sono più in basso o tagliabili in montaggio.
5. **Registra per scene,** non in un’unica ripresa. Il montaggio unisce; un cold start a metà non rovina tutto.

## Se il tempo stringe

Da 3:00 a 2:00 si tagliano, in quest’ordine: la scena 3 (Launch run), la scena 7 (biblioteca e robot) ridotta a una frase sopra lo scoreboard, la scena 6 (Security) ridotta a cinque secondi sulla lista. Le scene 1, 4 e 5 non si toccano: sono il prodotto.
