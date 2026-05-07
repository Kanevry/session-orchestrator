---
globs:
  - "**/*.swift"
  - "**/Package.swift"
  - "**/*.xcodeproj/**"
---
# Swift Rules (Path-scoped)

## Language & Style

- Swift 5.9+ (Swift 6 concurrency model where the target supports it).
- Enable strict concurrency checking (`-strict-concurrency=complete`) in `Package.swift` for new targets.
- Use `async`/`await` for all asynchronous code. Never use completion-handler callbacks in new code.
- Prefer value types (`struct`, `enum`) over reference types (`class`) unless shared mutable state is required.
- Mark reference types `final` unless inheritance is intentional and documented.
- Use `@MainActor` for UI-updating code. Isolate background work with structured concurrency (`TaskGroup`, `async let`).

## Testing

- Use Swift Testing framework (`import Testing`) for all new tests. Do NOT use XCTest for new code.
- Test file naming: `<FeatureName>Tests.swift` co-located with source in the same target.
- Parameterised tests: use `@Test(arguments:)` instead of duplicating test functions.
- Use `#expect` and `#require` (not `XCTAssert*`) for assertions.
- Mock protocols, not classes. Define `protocol`-based dependencies for all external calls.

## SwiftUI

- Extract view logic into `ViewModels` or use `@Observable` (iOS 17+) / `ObservableObject` (< iOS 17).
- Prefer composable, single-responsibility views. Split views that exceed ~100 lines of `body`.
- Avoid `AnyView` — it disables diffing optimisations. Use `@ViewBuilder` or generics instead.
- Use `task(id:)` for async view setup tied to identity. Avoid `onAppear` for network calls.
- Animations: use `.animation(.default, value:)` tied to state changes. Never animate on `onAppear` without a state guard.

## Networking

- Use `URLSession` with `async`/`await`. Wrap calls in `Actor`-isolated service types.
- Decode responses with `Codable` + `JSONDecoder`. Set `keyDecodingStrategy = .convertFromSnakeCase` for snake_case APIs.
- Always cancel network tasks when the owning view disappears (use `Task` stored in `@State` and `.cancel()` in `onDisappear`).
- Never call APIs directly from SwiftUI `View` body — always go through a `ViewModel` or service layer.

## Error Handling

- Define domain-specific `Error` enums conforming to `LocalizedError`. Provide `errorDescription` for user-facing messages.
- Use `Result<Success, Failure>` for APIs that callers must handle failures of.
- In async contexts, use `throws` + `try`/`catch`. Never silence errors with `try?` unless the failure is genuinely unimportant.
- Log errors with `Logger` from `os.log` (not `print`). Use subsystems and categories for structured filtering.

## Package Management (SPM)

- Use Swift Package Manager exclusively. No CocoaPods or Carthage for new projects.
- Pin exact versions in `Package.resolved`. Review and update dependencies with each minor release cycle.
- Keep `Package.swift` platforms list up to date with the minimum deployment target.
- Separate library targets from executable/app targets to maximise testability.

## Security

- Never hard-code secrets, API keys, or tokens in source. Use the Keychain or environment variables injected at build time.
- Use `SecureField` for password inputs. Never log or persist raw password strings.
- Certificate pinning for high-sensitivity apps (healthcare, financial). Use `URLSessionDelegate` + `SecTrustEvaluate`.
- Validate all server-sent data with Codable schemas. Never `force-unwrap` optional JSON fields.

## See Also
development.md · security.md · testing.md · test-quality.md · frontend.md · backend.md · mvp-scope.md · parallel-sessions.md · ai-agent.md
