# Namy HubSpot Proxy

API trung gian (proxy) trên AWS cho phép đối tác bên thứ 3 **đọc, tạo, cập nhật** contact trên HubSpot của Namy, **không có quyền xóa**. Đối tác không bao giờ cầm HubSpot token; token nằm trong AWS Secrets Manager và chỉ Lambda đọc được.

```
Đối tác ──① client_id/secret──► Cognito ──► access token (1 giờ, có scope)
   │
   └──② Bearer token──► WAF ──► API Gateway (5 route, kiểm scope, validate body)
                                    └──► Lambda ──► HubSpot API
                                           ├── Secrets Manager (HubSpot token)
                                           └── DynamoDB (log kiểm toán: ai sửa gì, giá trị trước/sau)
```

## Các thao tác đối tác được làm

| Endpoint | Scope | HubSpot |
|---|---|---|
| `GET /contacts?limit=&after=` | `namy-api/contacts.read` | `GET /crm/v3/objects/contacts` |
| `GET /contacts/{id}` | `namy-api/contacts.read` | `GET /crm/v3/objects/contacts/{id}` |
| `POST /contacts` | `namy-api/contacts.write` | `POST /crm/v3/objects/contacts` |
| `POST /contacts/batch` (≤ 100) | `namy-api/contacts.write` | `POST /crm/v3/objects/contacts/batch/create` |
| `PATCH /contacts/{id}` | `namy-api/contacts.write` | `PATCH /crm/v3/objects/contacts/{id}` |

Mọi method/đường dẫn khác (DELETE, archive, merge, object khác) **không tồn tại** trên API Gateway và trả `404 ROUTE_NOT_FOUND`. Đặc tả cho đối tác: [openapi.yaml](openapi.yaml).

## Các lớp bảo vệ

- **Không có route xóa.** Lambda cũng từ chối mọi route ngoài danh sách (405), phòng khi cấu hình API Gateway bị sửa nhầm.
- **Allowlist trường** trong [src/lib/config.ts](src/lib/config.ts):
  - `READ_PROPERTIES`: trường trả về cho đối tác, trường khác bị lọc bỏ.
  - `WRITE_PROPERTIES`: trường được ghi, trường khác trả `400 FIELD_NOT_ALLOWED`.
  - `NON_CLEARABLE_PROPERTIES`: không được xóa trắng qua update (chặn "xóa ngầm").
  - `CREATE_REQUIRED_PROPERTIES`: trường bắt buộc khi tạo.
- **Log kiểm toán** (DynamoDB): mỗi lần tạo/sửa ghi `clientId`, contact, trường đã đổi, **giá trị trước khi sửa** để khôi phục được. Bảng mã hóa, có point-in-time recovery, tự xóa sau `auditRetentionDays`.
- **Kiểm scope hai lần**: API Gateway (Cognito authorizer) và trong Lambda.
- **Không thử lại POST** khi HubSpot lỗi 5xx/timeout (tránh tạo trùng); chỉ thử lại khi `429`. GET/PATCH thử lại tối đa 3 lần khi gặp `429`, `5xx` hoặc lỗi mạng (không thử lại khi đã timeout, để không vượt thời gian chạy của Lambda).
- **Lỗi HubSpot không lộ ra ngoài**: lỗi xác thực HubSpot trả `502 UPSTREAM_ERROR` cho đối tác.
- **WAF**: giới hạn số request mỗi IP trong 5 phút (= `throttle.rateLimit` × 300), chặn input độc hại phổ biến, tùy chọn chỉ cho phép IP đối tác.
- **Log không chứa giá trị dữ liệu khách**, chỉ có id và tên trường.
- **Cảnh báo CloudWatch**: Lambda lỗi, API trả 5xx, ghi log kiểm toán thất bại, HubSpot throttle nhiều.

> ⚠️ Danh sách trường trong `src/lib/config.ts` đang là **giá trị mẫu**. Phải chốt với Namy trước khi lên prod, và cập nhật `ContactProperties` trong `openapi.yaml` cho khớp.

## Cấu trúc

```
infra/bin/app.ts           chọn môi trường (dev/prod) từ cdk.json
infra/lib/proxy-stack.ts   toàn bộ hạ tầng: Cognito, API Gateway, WAF, Lambda, Secrets Manager, DynamoDB, alarm
src/handler.ts             Lambda: định tuyến 5 thao tác
src/lib/                   config (allowlist), validate, hubspot client, secrets, audit, log, errors
test/                      unit test Lambda + test template hạ tầng
openapi.yaml               tài liệu API cho đối tác
cdk.json                   cấu hình từng môi trường
```

## Cấu hình môi trường (`cdk.json` → `context.environments`)

| Khóa | Ý nghĩa |
|---|---|
| `region` | Region AWS, mặc định `ap-southeast-1` |
| `cognitoDomainPrefix` | Tiền tố URL lấy token, **duy nhất toàn cầu**, không chứa chữ `aws`/`cognito` |
| `partners` | Danh sách đối tác: `{ "name": "abc", "scopes": ["read"] }` hoặc `["read","write"]` |
| `allowedIps` | IP đối tác dạng CIDR (vd `203.0.113.10/32`); để trống = không giới hạn IP |
| `alarmEmail` | Email nhận cảnh báo; để trống = không gửi |
| `auditRetentionDays` | Số ngày giữ log kiểm toán |
| `throttle` | Giới hạn request/giây của API |
| `reservedConcurrency` | (tùy chọn) Giới hạn số Lambda chạy song song để bảo vệ hạn mức HubSpot. Cần tài khoản AWS còn dư concurrency |

## Chạy và kiểm thử trên máy

```bash
npm install
npm run typecheck
npm test
npx cdk synth --context env=dev
```

## Deploy

**1. Chuẩn bị (làm một lần cho mỗi tài khoản/region):**

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-southeast-1
```

**2. Deploy:**

```bash
npm run deploy:dev
```

Prod: `npm run deploy:prod`. Nên chạy qua CI/CD có người duyệt, không deploy tay.

**3. Nhập HubSpot token thật vào Secrets Manager** (Namy làm; secret được tạo với giá trị ngẫu nhiên làm chỗ trống):

```bash
aws secretsmanager put-secret-value \
  --secret-id namy-hubspot-proxy/dev/hubspot-token \
  --secret-string 'pat-na1-xxxxxxxx'
```

- dev: dùng token của **HubSpot sandbox**, không dùng dữ liệu thật.
- Token lấy từ HubSpot: Settings → Integrations → Private Apps (giao diện mới: Development → Legacy apps), chỉ cấp `crm.objects.contacts.read` và `crm.objects.contacts.write`.
- Lambda tự đọc lại token sau tối đa 5 phút, hoặc ngay khi HubSpot trả 401.

**4. Lấy thông tin gửi cho đối tác.** `client_id` nằm trong output `PartnerClientId-<tên>` của stack. Lấy `client_secret`:

```bash
aws cognito-idp describe-user-pool-client \
  --user-pool-id <UserPoolId> --client-id <client_id> \
  --query 'UserPoolClient.ClientSecret' --output text
```

Gửi `client_id`, `client_secret`, `TokenUrl`, `ApiUrl` và `openapi.yaml` cho đối tác. **`client_secret` phải gửi qua kênh an toàn** (password manager dùng chung hoặc link tự hủy), không gửi qua email/chat thường.

## Đối tác gọi API

```bash
# Lấy token (dùng lại tới khi hết hạn, 1 giờ)
curl -X POST "<TokenUrl>" \
  -u "<client_id>:<client_secret>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=namy-api/contacts.read namy-api/contacts.write"

# Gọi API
curl "<ApiUrl>contacts?limit=20" -H "Authorization: Bearer <access_token>"

curl -X PATCH "<ApiUrl>contacts/101" \
  -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" \
  -d '{"properties":{"city":"Hanoi"}}'
```

## Vận hành

- **Thêm đối tác:** thêm vào `partners` trong `cdk.json`, deploy lại, lấy `client_secret` như bước 4.
- **Thu hồi đối tác:** xóa khỏi `partners` và deploy lại. Token đã cấp còn hiệu lực tối đa 1 giờ; cần chặn ngay thì thêm rule chặn IP trên WAF.
- **Xoay HubSpot token:** trên HubSpot bấm *Rotate*, rồi chạy lại lệnh `put-secret-value` ở bước 3.
- **Tra cứu ai đã sửa contact:** bảng DynamoDB (output `AuditTableName`), khóa `pk = contact#<id>`; theo đối tác dùng index `byClient`. Cột `before` chứa giá trị cũ để khôi phục.
- **Cảnh báo `AuditWriteFailed`:** thay đổi đã vào HubSpot nhưng chưa ghi được log kiểm toán. Tra CloudWatch log của Lambda theo `requestId` để bổ sung thủ công.

## Còn cần chốt với Namy

1. Danh sách trường được đọc / được ghi / không được xóa trắng / bắt buộc khi tạo.
2. Tạo contact trùng email: hiện trả `409 CONTACT_ALREADY_EXISTS`. Có cần chuyển sang cập nhật bản ghi cũ (upsert) không?
3. IP cố định của từng đối tác (để bật `allowedIps`).
4. Email nhận cảnh báo, thời gian giữ log kiểm toán.
5. Gói HubSpot đang dùng (hạn mức API) để đặt `throttle` và `reservedConcurrency` phù hợp.
