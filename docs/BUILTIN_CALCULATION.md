# Built-in calculation

Native agents receive `calculate({expression})` alongside source search and chat
tools. It needs no LibreChat account, API key, network service, or new package.
MultiContext executes it and retains the returned result in tool continuation.
Disabling search does not disable this offline tool.

Supported syntax: numbers (including scientific notation), `+ - * / ^`, unary
signs, and parentheses. Exponentiation is right-associative; `-2^2` is `-4` and
`(-2)^2` is `4`. Input is capped at 256 characters. Identifiers, function calls,
arbitrary code, non-finite intermediate results, and division by zero are rejected
with `INVALID_EXPRESSION`. Parsing never uses eval or dynamic code execution.

Results use IEEE-754 Float64 and are not exact symbolic arithmetic, dimensional
analysis, an inequality checker, or a proof. A correct value for a wrongly chosen
formula is still mathematically wrong. Results explicitly include
`proofVerified:false`; no claim is promoted to verified knowledge automatically.

Actual direct GPT-OSS probe: `node scripts/smoke-local-calculation.mjs` passed in
`data/experiments/local-calculation-1788817801213/`. The model called `calculate`,
the executor returned 4 for the requested Young-exponent check, and the model
finished using that result with no extra tool round. This is arithmetic-tool
execution evidence, not new Navier-Stokes insight. Raw turns/results are retained.

Node check: 318 total / 315 pass / 0 fail / 3 skip. After adding structured error
handling, the three calculation tests were rerun successfully. The running app
and installed LibreChat require refreshed deployment to advertise the new tool;
the real probe used current source directly.
