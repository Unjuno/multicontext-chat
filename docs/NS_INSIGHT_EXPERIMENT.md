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
