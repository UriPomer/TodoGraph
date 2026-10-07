import Capacitor
import StoreKit

@objc(ApplePurchasesPlugin)
public class ApplePurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApplePurchasesPlugin"
    public let jsName = "ApplePurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "entitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
    ]
    private var updates: Task<Void, Never>?
    private var productIDs: Set<String> { Set(getConfig().getArray("productIds")?.compactMap { $0 as? String } ?? []) }

    public override func load() {
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                guard case .verified(let transaction) = result, self.productIDs.contains(transaction.productID) else { continue }
                self.notifyListeners("entitlementsChanged", data: [:])
                await transaction.finish()
            }
        }
    }
    deinit { updates?.cancel() }

    @objc func entitlements(_ call: CAPPluginCall) {
        Task {
            var pro = false
            var expiration: Date?
            for await result in Transaction.currentEntitlements {
                guard case .verified(let transaction) = result,
                      productIDs.contains(transaction.productID),
                      transaction.revocationDate == nil,
                      transaction.productType == .nonConsumable || transaction.productType == .autoRenewable,
                      transaction.expirationDate == nil || transaction.expirationDate! > Date() else { continue }
                pro = true
                if let date = transaction.expirationDate { expiration = max(expiration ?? date, date) }
                else { expiration = nil; break }
            }
            var response: [String: Any] = ["plan": pro ? "pro" : "free", "source": "storekit", "purchaseAvailable": !productIDs.isEmpty]
            if let expiration { response["expiresAt"] = ISO8601DateFormatter().string(from: expiration) }
            call.resolve(response)
        }
    }

    @objc func products(_ call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: Array(productIDs))
                call.resolve(["products": products.filter { $0.type == .nonConsumable || $0.type == .autoRenewable }.map {
                    ["id": $0.id, "displayName": $0.displayName, "displayPrice": $0.displayPrice]
                }])
            } catch { call.reject("无法读取 App Store 产品", nil, error) }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let id = call.getString("productId"), productIDs.contains(id) else { call.reject("购买产品尚未配置"); return }
        Task {
            do {
                guard let product = try await Product.products(for: [id]).first,
                      product.type == .nonConsumable || product.type == .autoRenewable else { call.reject("产品不可用"); return }
                switch try await product.purchase() {
                case .success(let verification):
                    guard case .verified(let transaction) = verification else { call.reject("购买签名验证失败"); return }
                    await transaction.finish()
                    call.resolve(["status": "purchased"])
                case .userCancelled: call.resolve(["status": "cancelled"])
                case .pending: call.resolve(["status": "pending"])
                @unknown default: call.reject("未知购买状态")
                }
            } catch { call.reject("购买失败", nil, error) }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do { try await AppStore.sync(); call.resolve() }
            catch { call.reject("恢复购买失败", nil, error) }
        }
    }
}
