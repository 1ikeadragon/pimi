import CryptoKit
import Foundation
import LocalAuthentication
import Security

// Holds the vault key behind a Secure Enclave key that demands user presence (Touch ID, or the
// Mac password as the system's fallback). No keychain is used: the Secure Enclave key lives as an
// opaque blob that only this Mac's Secure Enclave can use, so the app stays ad-hoc signed.
//
//   available          prints {"secureEnclave":bool,"biometry":bool}
//   wrap               reads a 32-byte key as hex on stdin, prints the wrapped JSON. No prompt.
//   unwrap --reason T  reads that JSON on stdin, prompts, prints the key as hex.
//
// Exit codes: 0 ok, 2 the user cancelled, 3 the key is gone or cannot be restored, 1 anything else.

let wrapInfo = Data("pimi-vault-quick-unlock-v1".utf8)

struct Wrapped: Codable {
  let version: Int
  let seKey: String
  let ephemeralPublicKey: String
  let sealed: String
}

enum Failure: Error {
  case usage(String)
  case cancelled
  case keyGone
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func readStdin() -> Data {
  FileHandle.standardInput.readDataToEndOfFile()
}

func hexDecode(_ text: String) -> Data? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.count % 2 == 0 else { return nil }
  var data = Data()
  var index = trimmed.startIndex
  while index < trimmed.endIndex {
    let next = trimmed.index(index, offsetBy: 2)
    guard let byte = UInt8(trimmed[index..<next], radix: 16) else { return nil }
    data.append(byte)
    index = next
  }
  return data
}

func hexEncode(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

func derive(_ shared: SharedSecret) -> SymmetricKey {
  shared.hkdfDerivedSymmetricKey(
    using: SHA256.self, salt: Data(), sharedInfo: wrapInfo, outputByteCount: 32)
}

func available() {
  let context = LAContext()
  var error: NSError?
  let biometry = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
  let payload = ["secureEnclave": SecureEnclave.isAvailable, "biometry": biometry]
  let data = try! JSONSerialization.data(withJSONObject: payload)
  print(String(data: data, encoding: .utf8)!)
}

func wrap() throws {
  guard let key = hexDecode(String(decoding: readStdin(), as: UTF8.self)), key.count == 32 else {
    throw Failure.usage("wrap expects a 32-byte key as hex on stdin")
  }
  var error: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error)
  else { throw Failure.usage("could not create the access control") }
  let seKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
  let ephemeral = P256.KeyAgreement.PrivateKey()
  let shared = try ephemeral.sharedSecretFromKeyAgreement(with: seKey.publicKey)
  let sealed = try AES.GCM.seal(key, using: derive(shared)).combined!
  let wrapped = Wrapped(
    version: 1,
    seKey: seKey.dataRepresentation.base64EncodedString(),
    ephemeralPublicKey: ephemeral.publicKey.rawRepresentation.base64EncodedString(),
    sealed: sealed.base64EncodedString())
  FileHandle.standardOutput.write(try JSONEncoder().encode(wrapped))
  print("")
}

func unwrap(reason: String) throws {
  let wrapped = try JSONDecoder().decode(Wrapped.self, from: readStdin())
  guard
    wrapped.version == 1,
    let seKeyData = Data(base64Encoded: wrapped.seKey),
    let ephemeralData = Data(base64Encoded: wrapped.ephemeralPublicKey),
    let sealedData = Data(base64Encoded: wrapped.sealed)
  else { throw Failure.keyGone }
  let context = LAContext()
  context.localizedReason = reason
  let seKey: SecureEnclave.P256.KeyAgreement.PrivateKey
  let ephemeral: P256.KeyAgreement.PublicKey
  do {
    seKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      dataRepresentation: seKeyData, authenticationContext: context)
    ephemeral = try P256.KeyAgreement.PublicKey(rawRepresentation: ephemeralData)
  } catch {
    throw Failure.keyGone
  }
  do {
    let shared = try seKey.sharedSecretFromKeyAgreement(with: ephemeral)
    let key = try AES.GCM.open(AES.GCM.SealedBox(combined: sealedData), using: derive(shared))
    print(hexEncode(key))
  } catch let error as LAError where error.code == .userCancel || error.code == .appCancel
    || error.code == .systemCancel
  {
    throw Failure.cancelled
  } catch is CryptoKitError {
    throw Failure.keyGone
  }
}

@main
struct VaultKey {
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    do {
      switch args.first {
      case "available":
        available()
      case "wrap":
        try wrap()
      case "unwrap":
        guard let flag = args.firstIndex(of: "--reason"), flag + 1 < args.count else {
          throw Failure.usage("unwrap needs --reason <text>")
        }
        try unwrap(reason: args[flag + 1])
      default:
        throw Failure.usage("usage: pimi-vault-key available | wrap | unwrap --reason <text>")
      }
    } catch Failure.cancelled {
      fail("cancelled", code: 2)
    } catch Failure.keyGone {
      fail("key gone", code: 3)
    } catch Failure.usage(let message) {
      fail(message)
    } catch {
      fail("\(error)")
    }
  }
}
