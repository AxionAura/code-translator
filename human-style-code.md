Human-Style Code

Purpose

Write code like a competent, experienced software developer working on a real project.

The goal is not to imitate human mistakes, bypass AI detection, or make code artificially messy.

The goal is to produce code that feels naturally written because it is:

- Context-aware
- Intentional
- Simple where possible
- Explicit where necessary
- Consistent with the existing codebase
- Easy to read and debug
- Easy to review
- Easy to change later
- Appropriate for the project's actual scale

Code should look like the result of someone understanding the problem, the repository, and the trade-offs involved.

---

1. Repository First

Before writing or changing code, understand the repository.

Inspect the relevant:

- Source files
- Directory structure
- Existing implementations
- Configuration
- Tests
- Build scripts
- Package/dependency files
- Documentation
- CI configuration
- Existing utilities
- Existing error-handling patterns

Treat the existing codebase as the primary source of truth for local conventions.

Do not invent a new convention when the project already has one.

Do not rewrite existing code simply because another style is personally preferred.

Rule

«Understand the code around the change before deciding how the change should be written.»

---

2. Match the Existing Codebase

A good developer does not write every file according to their personal style.

Follow the repository's established conventions for:

- Naming
- Formatting
- File organization
- Imports
- Error handling
- Logging
- Types
- Testing
- API design
- Comments
- Abstractions
- Framework usage

If the repository consistently uses one approach, follow it unless there is a concrete reason to change it.

When existing code is inconsistent, prefer the convention used by the surrounding module rather than introducing another style.

---

3. Solve the Actual Problem

Implement the requested behavior.

Do not silently invent requirements.

Do not add features merely because they might be useful later.

Do not build infrastructure for hypothetical future requirements unless there is a concrete reason to do so.

Avoid:

"We might need this someday."

as the sole reason for adding complexity.

Prefer:

"Today's requirement needs this."

Important

Do not confuse completeness with adding more code.

A complete solution is one that correctly handles the actual requirements and realistic failure cases.

---

4. Think Before Coding

Before making a substantial change, mentally establish:

1. What is the current behavior?
2. What behavior should change?
3. Where should that behavior live?
4. What existing code can be reused?
5. What could break?
6. How will the change be verified?

Do not immediately generate a large implementation simply because the request sounds clear.

For small changes, keep this reasoning lightweight.

For architectural changes, investigate the repository properly before committing to a design.

---

5. Prefer Local Simplicity

Prefer the simplest design that is appropriate for the current problem.

Do not add:

- Factories without multiple meaningful implementations
- Interfaces without a real abstraction boundary
- Service layers that only forward calls
- Managers that merely wrap functions
- Generic helpers used once
- Configuration systems for fixed constants
- Extra modules solely to make the architecture look sophisticated
- Dependency injection everywhere
- Complex state management when local state is sufficient

Simple code is not automatically good code.

The correct rule is:

«Prefer the simplest solution that remains clear, correct, testable, and appropriate for the project's scale.»

---

6. Do Not Over-Engineer

Avoid speculative architecture.

Do not create abstractions merely because a pattern exists.

For example, do not turn:

send_email(user, message)

into:

EmailService
EmailProvider
EmailProviderFactory
EmailServiceManager
EmailServiceResolver

unless the application actually has a meaningful need for those boundaries.

Abstractions should earn their existence.

Good reasons include:

- Multiple implementations actually exist
- A stable boundary exists
- Reuse is substantial
- Testing genuinely benefits from the abstraction
- A domain concept deserves its own model
- The system has a real architectural boundary

Bad reason:

«"This might be useful in the future."»

---

7. Avoid Premature Generalization

Do not turn a concrete requirement into a generic framework unnecessarily.

If the application needs:

resize_avatar(image)

do not automatically create:

ImageTransformationPipeline
TransformationStrategy
TransformationRegistry
GenericMediaProcessor

unless the project actually needs that flexibility.

Start with the concrete problem.

Generalize when repeated requirements demonstrate that generalization is useful.

---

8. Functions Should Have a Clear Job

Functions should have a coherent purpose.

A function can perform several small operations when they naturally belong together.

Do not mechanically split every few lines into a separate function.

Bad:

load_user()
validate_user()
get_user_name()
check_user_name()
return_user_name()

when those functions add no meaningful abstraction.

Also avoid giant functions that handle unrelated responsibilities.

If a function contains several distinct conceptual steps, consider extracting those steps when doing so makes the code easier to understand or test.

Important

There is no universal line-count rule.

A 40-line straightforward function may be easier to understand than ten tiny functions whose relationships are difficult to follow.

Judge function size by:

- Complexity
- Nesting
- Number of responsibilities
- Local state
- Readability
- Reuse
- Testability

---

9. Names Should Carry Meaning

Names should make the code understandable without requiring comments.

Prefer:

retry_count
access_token
created_at
fetch_user_profile()
calculate_total()

over:

x
data
thing
obj
stuff
process()
handle()
do_work()

when the context does not make the shorter name obvious.

However, do not make every local variable unnecessarily verbose.

For example:

for i in range(len(items)):

can reasonably use "i".

A short local variable with a tiny scope can be clearer than an extremely descriptive name.

General principle

«The wider the scope and the farther a reader must look to understand a name, the more descriptive the name should be.»

This is consistent with practices documented in Google and Go style guidance.

---

10. Avoid Meaningless Naming Patterns

Do not automatically prefix everything with generic words such as:

data
result
response
object
manager
handler
service
utils
helper
processor

unless the word actually communicates something useful.

For example:

user_data

may be appropriate if it specifically represents serialized user data.

But:

data

for an entire application state object is usually weak.

Likewise, do not create meaningless modules such as:

utils/
helpers/
common/
misc/

when a more specific domain name is available.

Go's code-review guidance similarly warns against meaningless package names such as "util", "common", "misc", "api", "types", and "interfaces".

---

11. Names Should Reflect Domain Language

Use terminology that matches the actual domain.

If the application calls something an "order", do not randomly call it:

transaction
request
purchase
item

unless those are actually different concepts.

Consistent domain vocabulary reduces mental translation.

---

12. Comments Are Not a Substitute for Clear Code

Before writing a comment, ask:

«Could the code itself be made clearer?»

Prefer:

if user.is_verified:
    send_invoice(user)

over:

# Check whether the user has verified their account
if user.is_verified:
    # Send the invoice
    send_invoice(user)

The code already explains what it does.

Comments should add information the code cannot reasonably express.

---

13. Explain Why, Constraints, and Non-Obvious Decisions

Useful comments explain things such as:

- Why an unusual implementation exists
- Why a seemingly obvious alternative was rejected
- An external constraint
- A compatibility requirement
- A security reason
- A performance trade-off
- A business rule
- A non-obvious invariant

Example:

# The upstream API occasionally returns 429 even below the documented
# rate limit, so retry this request with exponential backoff.

This is useful because the reason is not obvious from the code.

---

14. Do Not Write AI-Style Commentary

Avoid automatically adding comments like:

# Initialize the variable
# Process the data
# Check if the user exists
# Return the result

to every block.

Avoid long explanatory essays inside ordinary implementation code.

Avoid comments that merely translate code into English.

Do not comment every line.

Good comments are selective.

Google and Linux Kernel guidance both emphasize that comments should add useful information rather than explain obvious code.

---

15. Do Not Intentionally Write Bad Code to Look Human

Never introduce artificial imperfections such as:

- Typos
- Random abbreviations
- Inconsistent naming
- Unnecessary duplication
- Strange formatting
- Random comments
- Arbitrary complexity
- Deliberately inefficient code
- Fake mistakes
- Inconsistent architecture

Human-written code is not defined by being messy.

The objective is natural engineering judgment, not simulated imperfection.

---

16. Avoid Cleverness

Prefer obvious code over clever code.

Avoid unnecessarily dense:

- One-liners
- Nested ternaries
- Operator tricks
- Metaprogramming
- Reflection
- Magic behavior
- Deep functional chains
- Obscure language features
- Extremely compressed expressions

unless the project already uses that style and it genuinely improves the code.

A reader should not need to mentally decode a simple operation.

---

17. Use Abstraction When It Reduces Complexity

Abstraction is useful when it makes the system easier to understand or change.

Do not avoid abstraction just because "simple code" sounds better.

Use an abstraction when there is a real reason.

Examples:

- Several implementations share a stable contract.
- A complex subsystem needs a clean boundary.
- A domain concept has meaningful behavior.
- A repeated operation has enough complexity to deserve a name.
- Dependency boundaries improve testing or maintainability.

The goal is not:

«Minimum number of classes.»

The goal is:

«Minimum unnecessary complexity.»

---

18. Duplication: Do Not Abstract Too Early

Do not immediately extract every repeated line.

Two pieces of code can look similar while representing different concepts.

Before deduplicating, ask:

- Do these pieces change for the same reasons?
- Do they represent the same concept?
- Will they evolve together?
- Would the abstraction make both callers clearer?

If not, duplication may be preferable to a bad abstraction.

---

19. Avoid Dead Code

Do not leave:

- Unused functions
- Unused variables
- Unused imports
- Disabled code
- Old implementations
- Commented-out blocks
- Unreachable branches

unless there is a documented reason.

Version control exists to preserve history.

Do not use comments as a graveyard for old code.

---

20. Do Not Make Every Constant Configurable

Not every value belongs in:

.env
config.yaml
config.json
environment variables
database settings

A value should generally become configuration when it is expected to vary by:

- Environment
- Deployment
- Customer
- Installation
- Operational policy

If a value is simply an implementation constant, keeping it in code may be clearer.

---

21. Error Handling Must Be Intentional

Do not blindly catch every exception.

Avoid:

try:
    do_something()
except Exception:
    pass

This hides failures.

Prefer handling errors where there is a meaningful response.

For example:

try:
    result = fetch_user(user_id)
except ConnectionError:
    return retry_request()

If an error cannot be meaningfully handled at the current level, propagate it to a layer that can handle it.

Do not silently discard errors.

Do not pretend an operation succeeded when it did not.

Go's review guidance explicitly emphasizes checking, handling, or returning errors rather than discarding them.

---

22. Error Messages Should Help Debugging

Good errors answer useful questions:

- What failed?
- Which operation failed?
- Which resource was involved?
- What condition caused the failure?
- Can the caller recover?

Bad:

Something went wrong.
Invalid error.
Failed.

Better:

Failed to fetch user profile: upstream returned HTTP 503

Do not expose secrets or sensitive information in errors.

---

23. Validate at Boundaries

Treat external input as untrusted.

Validate data coming from:

- HTTP requests
- Forms
- APIs
- Files
- Environment variables
- CLI arguments
- Databases when assumptions matter
- External services

Do not assume external data has the structure or constraints you expect.

But avoid repeatedly validating the same invariant in every internal function when a clear boundary already guarantees it.

---

24. Security Is Part of Normal Code Quality

Do not treat security as an optional final pass.

Pay attention to:

- Authentication
- Authorization
- Input validation
- Injection
- XSS
- CSRF
- SSRF
- Path traversal
- Command execution
- Secret management
- Sensitive data exposure
- Dependency vulnerabilities
- Unsafe deserialization
- File permissions

Never hard-code:

passwords
API keys
private keys
access tokens
database credentials

into source code.

Do not log secrets.

Do not weaken security controls merely to make implementation easier.

---

25. Logging Should Be Useful

Logs should help someone understand what happened in production.

Avoid noisy logs such as:

Starting...
Started...
Processing...
Processing complete...
Finished...

for ordinary internal operations.

Prefer meaningful events:

Failed to upload video: channel_id=123, status=503

Use the project's existing logging system.

Do not introduce a new logging framework unnecessarily.

Never log:

- Passwords
- API tokens
- Session tokens
- Private keys
- Sensitive personal information

---

26. Concurrency Should Be Understandable

Do not introduce concurrency merely because it sounds faster.

Before using:

- Threads
- Processes
- Async tasks
- Goroutines
- Workers
- Queues
- Parallel execution

consider:

- Is the work actually parallelizable?
- Is it I/O-bound or CPU-bound?
- What is the lifetime of each task?
- How are failures handled?
- Can tasks race?
- Who owns shared state?
- How are resources cleaned up?

Concurrent code should have an understandable lifecycle.

If concurrency makes correctness substantially harder without a meaningful benefit, prefer the simpler approach.

---

27. Performance: Avoid Both Extremes

Do not optimize everything prematurely.

Also do not ignore obvious expensive behavior.

Consider:

- Database queries inside loops
- Repeated network requests
- Unbounded memory growth
- Unnecessary serialization
- Large file copies
- Excessive API calls
- Repeated expensive computation

Use measurement when performance matters.

Do not replace readable code with complicated micro-optimizations without evidence that the optimization matters.

---

28. Database Code Should Be Deliberate

Be aware of:

- Query count
- Transactions
- Index usage
- N+1 queries
- Pagination
- Connection handling
- Race conditions
- Data consistency

Do not hide database access inside surprising helper functions.

A function that performs I/O should be reasonably obvious from its name or context.

---

29. Network Code Should Assume Failure

External services can:

- Timeout
- Return invalid responses
- Return unexpected status codes
- Rate-limit requests
- Disconnect
- Change behavior
- Become temporarily unavailable

Use appropriate:

- Timeouts
- Retries
- Backoff
- Status handling
- Validation
- Cancellation

Do not blindly retry every failure.

Retries should be appropriate to the operation and should not accidentally duplicate non-idempotent actions.

---

30. Dependencies Should Earn Their Place

Before adding a dependency:

1. Check whether the project already has an equivalent.
2. Check whether the standard library can reasonably solve the problem.
3. Consider the dependency's maintenance status.
4. Consider its security and supply-chain implications.
5. Consider its size and complexity.
6. Decide whether the benefit justifies adding it.

Do not add a large dependency to perform a trivial operation.

---

31. Respect Framework Conventions

When using a framework, follow its established conventions unless there is a concrete reason not to.

Do not fight the framework by building a parallel architecture around it.

Examples include:

- Django conventions
- Rails conventions
- Laravel conventions
- Next.js conventions
- React conventions
- FastAPI conventions
- Spring conventions
- Go project conventions

The repository's actual framework usage is more important than generic architectural advice.

---

32. Tests Should Test Behavior

Tests should primarily verify behavior that matters to users or callers.

Prefer tests that answer:

«Given this input/state, does the system produce the expected behavior?»

Avoid tests that tightly couple themselves to irrelevant implementation details.

For example, if an implementation changes from:

function A → function B → database

to:

function A → cache → database

tests for the public behavior should generally remain valid if the behavior has not changed.

Google's testing guidance explicitly recommends focusing tests on public behavior rather than unnecessary implementation details.

---

33. Write Tests Where They Provide Value

Prioritize tests for:

- Core business logic
- Important edge cases
- Critical workflows
- Public APIs
- Security-sensitive behavior
- Previously broken behavior
- Data transformations

Do not create tests merely to increase test count.

A small number of meaningful tests is better than a large collection of brittle tests.

---

34. Bug Fixes Should Protect Against Regression

When fixing a bug:

1. Understand the root cause.
2. Fix the underlying problem.
3. Verify the original failure is gone.
4. Add a regression test when practical.
5. Check nearby behavior.

Do not permanently patch symptoms if the underlying cause remains.

---

35. Keep Changes Focused

When asked to modify one feature, avoid unrelated refactoring.

Do not turn:

«"Fix the login bug."»

into:

«"Rewrite the authentication architecture."»

unless the existing architecture genuinely prevents the fix.

Focused changes are easier to:

- Review
- Test
- Debug
- Revert
- Merge

Google's review guidance specifically emphasizes keeping unrelated formatting/style changes separate from functional changes, while current engineering guidance similarly favors focused changes.

---

36. Do Not Reformat Unrelated Code

If one function needs changing, do not automatically reformat the entire file.

Avoid mixing:

functional changes
+
mass formatting changes
+
unrelated refactoring
+
renaming

in one change.

This makes review and debugging harder.

---

37. Refactor When the Evidence Justifies It

Refactoring is valuable when the existing structure is actively making changes harder.

Look for signals such as:

- Repeated logic
- Long functions
- Large classes with unrelated responsibilities
- Excessive nesting
- Confusing conditionals
- Shotgun changes across many files
- Dead code
- Speculative abstractions
- Tight coupling

These are common code-smell categories documented in established refactoring literature.

But a code smell is a signal, not an automatic command to refactor.

---

38. Readability Beats Clever Compression

Prefer:

user = get_user(user_id)

if user is None:
    raise UserNotFoundError(user_id)

profile = build_profile(user)

return profile

over an unnecessarily compressed expression when the expanded form communicates the flow better.

Whitespace should separate meaningful thoughts.

Do not remove line breaks merely to reduce line count.

Google's style guidance treats whitespace as a readability tool, not merely formatting.

---

39. But Do Not Expand Simple Code Artificially

Avoid turning:

total = price * quantity

into:

calculated_price = price
calculated_quantity = quantity
multiplication_result = calculated_price * calculated_quantity
total = multiplication_result

just to make the code look more "human."

Clarity includes knowing when code is already obvious.

---

40. Use Language Idioms

Write code in the natural style of the language.

Examples:

- Python should generally look like Python.
- Go should generally look like Go.
- JavaScript should generally look like JavaScript.
- Rust should generally look like Rust.
- Java should generally look like Java.

Do not force patterns from another language onto the current one.

Follow the ecosystem's established conventions where appropriate.

---

41. Formatting Is Mechanical; Judgment Is Not

Use the project's formatter when one exists.

Examples:

gofmt
rustfmt
black
prettier
clang-format
dotnet format

Do not manually fight an established formatter.

Formatting should be automated.

Human judgment should focus on:

- Architecture
- Naming
- Boundaries
- Complexity
- Behavior
- Error handling
- Trade-offs

---

42. Type Safety Should Match the Project

Use the type system to make important assumptions explicit.

Do not use:

any
Object
dynamic
interface{}
unknown

as an escape hatch when the actual structure is known.

But do not create elaborate type machinery for trivial local values.

Use enough type information to make important contracts clear without turning simple code into type ceremony.

---

43. Avoid Magic Values

If a value has domain meaning, give it a meaningful name.

Instead of:

if retry_count > 3:

consider:

MAX_RETRIES = 3

if retry_count > MAX_RETRIES:

when the value has meaningful policy semantics.

But do not create constants for every literal:

ZERO = 0
ONE = 1

Use judgment.

---

44. Preserve Existing APIs Unless Change Is Required

When modifying existing code:

- Preserve function signatures when possible.
- Preserve response formats.
- Preserve database contracts.
- Preserve configuration behavior.
- Preserve public interfaces.

If a breaking change is genuinely required, make it explicit.

Do not silently change behavior unrelated to the requested work.

---

45. Backward Compatibility Is Context-Dependent

Do not blindly preserve every historical behavior.

Consider:

- Is the API public?
- Are there known consumers?
- Is this an internal application?
- Is the old behavior actually a bug?
- Does the project have versioning?
- Is migration possible?

Good engineering balances compatibility against correctness and maintainability.

---

46. Do Not Hide Important Control Flow

Avoid excessive indirection.

A developer should be able to trace an important operation without jumping through ten wrappers.

Bad architecture often looks like:

Controller
  → Manager
    → Service
      → Handler
        → Processor
          → Utility
            → Repository

when most layers simply forward arguments.

Use layers when they represent real boundaries.

---

47. Keep Related Logic Together

If two pieces of logic always change together and belong to the same concept, keeping them close can improve readability.

Do not split code into many files simply because "small files are cleaner."

File boundaries should help people navigate the system.

---

48. Keep Unrelated Logic Separate

Conversely, avoid giant files containing:

- Authentication
- Payments
- Image processing
- Database utilities
- Email
- User management
- Random helpers

when the project has grown enough that these are distinct concerns.

Organize code around meaningful boundaries.

---

49. Prefer Explicit Data Flow

Important inputs and outputs should be reasonably visible.

Avoid hidden global state when local state or explicit parameters are sufficient.

Be cautious with:

- Global mutable variables
- Singleton state
- Implicit context
- Hidden side effects
- Monkey patching
- Magical dependency lookup

Explicit dependencies make code easier to understand and test.

---

50. Side Effects Should Be Understandable

A function that sounds like:

calculate_total()

should generally not unexpectedly:

- Write to the database
- Send an email
- Delete files
- Modify global state
- Make network requests

Names should give reasonable clues about side effects.

For example:

save_order()
send_notification()
delete_file()

make their effects more apparent.

---

51. Do Not Hide Expensive Operations

Operations involving:

- Network
- Database
- Disk
- Large computation
- External processes

should not be disguised as trivial in-memory operations when that distinction matters.

For example:

get_user()

may be fine if repository conventions make I/O obvious.

But in a performance-sensitive context, names and structure should make expensive operations discoverable.

---

52. Handle Resources Correctly

Clean up resources such as:

- Files
- Database connections
- Sockets
- Temporary files
- Processes
- Locks
- Transactions
- Streams

Use the language/framework's standard resource-management mechanism.

Do not rely on garbage collection or luck when deterministic cleanup is required.

---

53. Do Not Swallow Unexpected Failures

Unexpected failures should remain visible.

Avoid:

except Exception:
    return None

when that converts a serious failure into a misleading "not found" result.

Distinguish:

not found
invalid input
permission denied
temporary failure
unexpected failure

when the distinction matters.

---

54. Handle Edge Cases Based on Reality

Consider realistic edge cases.

Examples:

- Empty input
- Missing values
- Duplicate requests
- Timeouts
- Invalid IDs
- Expired sessions
- Partial failures
- Concurrent updates
- Large input
- Permission changes

Do not fill the code with absurd hypothetical cases merely to appear defensive.

---

55. Avoid Needless Defensive Noise

This:

if user is not None:
    if user.profile is not None:
        if user.profile.name is not None:
            ...

is not automatically safer.

Use the language's appropriate mechanisms for optional values and validation.

Defensive programming should clarify actual assumptions, not bury the main logic.

---

56. Configuration and Secrets

Never commit secrets.

Use the project's established secret/configuration mechanism.

Do not create fake secrets in source code such as:

API_KEY = "replace-me"

unless it is clearly an intentionally non-secret example.

Never expose real credentials in:

- Source code
- Logs
- Error messages
- Tests
- Documentation
- Git history

---

57. Do Not Invent APIs or Libraries

When implementing against an external library or service:

- Inspect its actual API when available.
- Follow the version used by the project.
- Check existing project usage.
- Do not invent method names.
- Do not assume a feature exists.

If uncertain, investigate before implementing.

---

58. Respect Existing Dependency Versions

Do not casually upgrade dependencies while implementing an unrelated feature.

Dependency upgrades can introduce:

- Breaking changes
- Security changes
- Behavior changes
- Build issues

Upgrade only when necessary or explicitly requested.

---

59. Generated Code Is Different

Do not manually apply these principles to code that is intentionally generated by:

- Protocol compilers
- ORM generators
- OpenAPI generators
- GraphQL generators
- Code generators
- Build systems

Generated code should follow the generator's conventions.

Human-written code surrounding it should remain maintainable.

---

60. Do Not Pretend Work Was Done

Never claim:

Tests passed.
Build succeeded.
API verified.
Migration tested.

unless those checks were actually performed.

If a check could not be run, say so clearly.

Honest verification is more valuable than confident reporting.

---

61. Before Finishing a Change

Review the final change as another developer would.

Ask:

Correctness

- Does it solve the requested problem?
- Does it preserve unrelated behavior?
- Are realistic failure cases handled?

Readability

- Can another developer understand it quickly?
- Are names meaningful?
- Is the control flow obvious?

Complexity

- Did I introduce unnecessary abstractions?
- Could this be simpler?
- Did I create a framework for a one-off requirement?

Consistency

- Does it follow the repository's conventions?
- Does it use existing utilities and patterns?

Scope

- Did I modify unrelated code?
- Did I accidentally reformat unrelated files?

Safety

- Did I introduce a security issue?
- Are secrets protected?
- Are external inputs validated appropriately?

Testing

- Did I test important behavior?
- Did I add a regression test where useful?
- Did I actually run the checks I claim to have run?

Cleanliness

- Any unused imports?
- Any dead code?
- Any debugging statements?
- Any accidental files?
- Any unnecessary dependencies?

---

62. When Multiple Solutions Exist

Do not automatically choose the most sophisticated solution.

Compare solutions based on:

- Correctness
- Simplicity
- Existing architecture
- Maintainability
- Performance
- Security
- Testability
- Operational cost
- Future change requirements

Choose the solution with the best trade-off for the actual project.

Do not optimize for architectural impressiveness.

---

63. When the Existing Code Is Bad

Do not blindly copy bad patterns just because they already exist.

There are two competing principles:

1. Preserve consistency.
2. Improve code quality.

Use judgment.

If the existing pattern is merely a stylistic preference, follow it.

If the existing pattern introduces:

- Security problems
- Data corruption
- Serious maintainability problems
- Clear correctness bugs
- Dangerous duplication
- Architectural constraints

then improve it when relevant to the requested change.

Do not spread a known problem just for consistency.

---

64. Human Developer Behavior

When writing code, behave like a developer who expects another developer to maintain it later.

That means:

- Read before editing.
- Search before creating a helper.
- Reuse before duplicating.
- Prefer clear names.
- Keep important logic visible.
- Comment decisions, not obvious syntax.
- Handle real errors.
- Test meaningful behavior.
- Keep changes focused.
- Refactor when the evidence supports it.
- Avoid speculative architecture.
- Respect the language and framework.
- Verify the final result.

Do not write code merely because it satisfies the immediate prompt.

Write code that fits the system.

---

65. Final Principle

The target is not:

«"Make the code look human."»

The target is:

«"Make the code look like it was written by someone who understood the system."»

Good human-style code is not defined by imperfections.

It is defined by judgment.

Use the existing codebase as context, choose the simplest appropriate design, make important decisions explicit, avoid unnecessary abstraction, keep behavior testable, and leave the repository easier to understand than you found it.