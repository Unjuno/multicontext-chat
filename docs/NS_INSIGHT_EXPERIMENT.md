# Bounded Navier–Stokes insight experiment

Run with `node --env-file=.env scripts/experiment-ns-insights.mjs AGENT_ID`.

This experiment asks two local-model personas to independently derive/check an
enstrophy estimate and its scaling obstruction. A third persona then audits their
reports. It uses the canonical application send operation and Scheduler, with at
most two simultaneous requests. Peer reports are explicitly labeled untrusted.
The aim is to find a checkable next mathematical question, not manufacture a claim
that the Millennium problem is solved.

Evidence is retained under ignored `data/experiments/ns-insights-TIMESTAMP/`:
state, ordered request/response trace, peer reports, and final workspace/result.
Request count and elapsed wall time are measured; token savings are not inferred.
Model completions and successful execution are not mathematical verification.
No existing user workspace is stopped or modified.

Initial launch: `ns-insights-1788815305320`, workspace
`000c2d39-4d69-4a53-a5bb-8a5adeddd4ad`. At launch two worker requests were running.
Completion and the mathematical content must be inspected in the recorded result;
this document does not certify them in advance.

## Observed first-run outcome

The run completed in 88,190 ms with six model requests and three completed member
tasks. Runtime execution passed; mathematical usefulness **failed this first trial**.
The auditor did not catch elementary exponent errors and reinforced some of them.
Its generic demand for peer-reviewed sources was not a substitute for calculation.
The models also exceeded the requested brevity and the auditor called `list_chats`
despite an instruction not to do so. These are observed model behavior, not evidence
of a queue failure or of successful mathematical verification.

Specific rejected claims (direct change-of-variable/algebra checks):

- For `u_lambda(x,t)=lambda*u(lambda*x,lambda^2*t)` in three dimensions,
  kinetic energy scales as `lambda^-1`, not `lambda^0`; squared vorticity L2
  norm scales as `lambda^1`, not `lambda^2`; squared gradient-vorticity L2 norm
  and integrated vortex stretching scale as `lambda^3`.
- In `||omega||_4 <= C ||grad omega||_2^theta ||omega||_2^(1-theta)`,
  `1/4 = (1-theta)/2 + theta/6` gives `theta=3/4`, not `1/4`.
  Thus the usual bound is `C E^(3/4) P^(3/4)` with `E=||omega||_2^2`,
  `P=||grad omega||_2^2`. Young with conjugate powers `4/3,4` gives
  `nu P/2 + C nu^-3 E^3`, not the reports' powers.
- An upper differential estimate `E' <= C nu^-3 E^3` only gives finite-time
  a priori control. Divergence of its comparison solution does not prove PDE blowup.
- Singular-integral Lp boundedness must not be extended to `p=infinity` as
  an ordinary L-infinity bound. The proposer's actual use at `p=4` is different.
- References and alleged contents of papers in the reports remain unverified.

Official scope reference: [Fefferman's problem statement](https://www.claymath.org/wp-content/uploads/2022/06/navierstokes.pdf).
The checks above are elementary derivations, not results extracted from metadata.

Next experiment should split the arithmetic into short independently checkable
tasks (Jacobian, interpolation equation, Young exponents) before soliciting a new
estimate. Do not feed the failed synthesis back as trusted knowledge. The raw
reports remain preserved for later error analysis. No token-efficiency claim can
be made: the provider returned zero-valued usage counters.

## Focused arithmetic gate

Run the same script with `--focused`. The two initial prompts request numeric JSON
for scaling and interpolation/Young exponents. `scripts/ns-exponent-checks.mjs`
checks these against independently derived task-specific values. This is **not**
a general proof verifier. Only when both checks pass is the synthesis task sent;
otherwise the recorded result is `REJECTED_AT_ARITHMETIC_GATE` and exit status 2.
Raw reports are retained whether they pass or fail. This is experiment orchestration,
not a new automatic Stop capability available to MCP agents.

Run `ns-insights-1788815500240`, workspace
`c1df55c9-26bc-4589-8446-0e837f4221a0`, completed with two model requests.
The scaling report got all four exponents correct. The interpolation report got
theta=0.75 correct, but confused norms with squared norms (1.5 rather than 0.75)
and got Young/viscosity/final powers wrong. The gate rejected it and no synthesis
request was made. This prevents this known error from propagating, but does not
demonstrate successful insight discovery or efficient end-to-end theorem research.

Regression checks cover observed wrong values, missing fields, invalid JSON,
null, numeric strings, and correct exponent records. Next targeted repair should
ask the failing worker to distinguish `||w||` from `E=||w||^2` and solve conjugacy
equations explicitly, without supplying the expected answers as discoveries.

## One corrective-feedback attempt

`--focused --repair` allows exactly one follow-up to each failing member, using
its existing conversation. The feedback names mismatched fields and gives a
calculation strategy, not the expected numeric answers. Original and repaired
reports/checks are stored separately; failure still prevents synthesis.

Run `ns-insights-1788815595826`, workspace
`db9a82ce-b8f1-438f-9f5a-8cf8f82e685b`, used three model requests. Initially the
scaling task passed and the interpolation task failed only `viscosityPower`
(returned 0.5). After feedback it returned 0 and also changed the previously
correct `palinstrophyPower` from 0.75 to 1.5. The run was rejected without synthesis.
Thus corrective feedback in the same context did **not** improve this trial.
Do not label the mechanism an accuracy improvement or retry indefinitely.

The next research strategy should use independently checked computational steps
as inputs and reserve model effort for proposing structural assumptions and
falsification questions. Broad end-to-end utility remains unproven. Separately,
the original product audit still needs real provider-owned/external mixed-tool
wire evidence; passing these external-search experiments cannot close that gate.
