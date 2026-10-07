import Capacitor
import CloudKit

@objc(AppleCloudPlugin)
public class AppleCloudPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleCloudPlugin"
    public let jsName = "AppleCloud"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "account", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
    ]
    private let recordID = CKRecord.ID(recordName: "todograph-workspace")
    private func container() throws -> CKContainer {
        guard let id = getConfig().getString("containerId"), !id.isEmpty else { throw NSError(domain: "TodoGraph", code: 1, userInfo: [NSLocalizedDescriptionKey: "iCloud 同步尚未配置"]) }
        return CKContainer(identifier: id)
    }

    @objc func account(_ call: CAPPluginCall) {
        Task {
            do {
                let container = try container()
                guard try await container.accountStatus() == .available else { call.reject("请在系统设置中登录并启用 iCloud"); return }
                let id = try await container.userRecordID()
                call.resolve(["accountId": id.recordName])
            } catch { call.reject("无法访问 iCloud 账号", nil, error) }
        }
    }
    @objc func read(_ call: CAPPluginCall) {
        Task {
            do {
                let record = try await container().privateCloudDatabase.record(for: recordID)
                guard let asset = record["workspaceFile"] as? CKAsset, let url = asset.fileURL, let tag = record.recordChangeTag else { call.reject("iCloud 工作区数据无效"); return }
                let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                guard let bytes = attributes[.size] as? NSNumber, bytes.intValue <= 20 * 1024 * 1024,
                      let payload = String(data: try Data(contentsOf: url), encoding: .utf8) else { call.reject("iCloud 工作区文件无效或超过 20 MB"); return }
                call.resolve(["payload": payload, "tag": tag])
            } catch let error as CKError where error.code == .unknownItem { call.resolve([:]) }
            catch { call.reject("读取 iCloud 失败", nil, error) }
        }
    }
    @objc func write(_ call: CAPPluginCall) {
        guard let payload = call.getString("payload"), payload.utf8.count <= 20 * 1024 * 1024 else { call.reject("iCloud 工作区超过 20 MB 同步上限"); return }
        let expectedTag = call.getString("expectedTag")
        Task {
            do {
                let database = try container().privateCloudDatabase
                let record: CKRecord
                do { record = try await database.record(for: recordID) }
                catch let error as CKError where error.code == .unknownItem { record = CKRecord(recordType: "TodoGraphWorkspace", recordID: recordID) }
                guard record.recordChangeTag == expectedTag else { call.reject("iCloud 版本已变化，请重新同步"); return }
                let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("todograph-\(UUID().uuidString).json")
                try Data(payload.utf8).write(to: fileURL, options: .atomic)
                defer { try? FileManager.default.removeItem(at: fileURL) }
                record["workspaceFile"] = CKAsset(fileURL: fileURL)
                let saved = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CKRecord, Error>) in
                    let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
                    operation.savePolicy = .ifServerRecordUnchanged
                    operation.isAtomic = true
                    operation.modifyRecordsCompletionBlock = { records, _, error in
                        if let error { continuation.resume(throwing: error) }
                        else if let saved = records?.first { continuation.resume(returning: saved) }
                        else { continuation.resume(throwing: NSError(domain: "TodoGraph", code: 2)) }
                    }
                    database.add(operation)
                }
                guard let tag = saved.recordChangeTag else { call.reject("iCloud 响应缺少版本"); return }
                call.resolve(["tag": tag])
            } catch { call.reject("保存 iCloud 失败，本机数据仍保留", nil, error) }
        }
    }
}
