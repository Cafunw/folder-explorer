# Folder Explorer

Windows masaüstünü telefon ana ekranı gibi kullanmanı sağlar: bir simgeyi başka bir simgenin
üstüne bırakınca klasör oluşur, klasörler iç içe olabilir, her şey animasyonlu ve özelleştirilebilir.

Klasörler **sanaldır**: dosyaların diskte yerinden oynamaz, gruplama yalnızca Folder Explorer'ın
kaydında tutulur. Uygulama kapanınca Windows'un kendi simgeleri geri gelir.

## Kullanım

| İşlem | Nasıl |
|---|---|
| Klasör oluştur | Bir simgeyi başka bir simgenin ortasına sürükle-bırak |
| Klasöre ekle | Simgeyi klasörün üstüne bırak (üstünde beklersen klasör açılır) |
| Klasörden çıkar | Açık klasörden simgeyi panelin dışına sürükle |
| Yer değiştir | Simgeyi dolu bir hücrenin kenarına bırak |
| Klasörü aç | Klasöre tek tıkla; Esc bir üst seviyeye döner |
| Yeniden adlandır | F2 (gerçek dosyanın adı değişir) ya da klasör başlığına tıkla |
| Sil | Delete → Geri Dönüşüm Kutusu (klasör silinince içindekiler dışarı çıkar) |
| Geri al / yinele | Ctrl+Z / Ctrl+Y |
| Sayfa değiştir | Fare tekerleği, ← →, ya da sürüklerken ekran kenarında bekle |
| Ara | Ctrl+Space ya da masaüstündeyken yazmaya başla |
| Çoklu seçim | Ctrl+tık ya da boş alanda dikdörtgen çiz |

**Temel kural: Windows'a dokunmuyoruz.** Windows'un gerçek masaüstü menüsü (Yenile, Görünüm,
Sırala, Yeni ▸ Klasör / Kısayol…, Kişiselleştir) olduğu gibi çalışır: boş bir yere sağ tıkladığında
tıklama doğrudan Windows'a geçer ve menüyü Windows'un kendisi açar. Uygulama kayıt defterini
değiştirmez, Explorer'a müdahale etmez, sistem menülerine kanca takmaz. Tek müdahale, kendi
simgelerimizi gösterirken Windows'un simge listesini gizlemektir; uygulama kapanınca (ya da
çökünce) Windows'un simgeleri geri gelir.

Kendi simgelerine sağ tık, o simge için Windows'un gerçek öğe menüsünü açar (Aç, Kes, Kopyala,
Paylaş…; Yeniden adlandır ve Sil'i uygulama yapar, böylece geri alınabilir). Gruba (sanal klasör)
sağ tıklamak onun ayar penceresini açar (ad, renk, görünüm, "Grubu dağıt", "İçindekilerle birlikte
sil"). Seçili simge için Ctrl+E de aynı pencereyi açar (dosyalar için özel ad ve simge).

Yeni grup için: sistem tepsisi menüsünde "Yeni grup", **Ctrl+Shift+N**, ya da bir simgeyi başka bir
simgenin üstüne bırakmak. Windows'un "Yeni ▸ Klasör" ile oluşturduğun öğe sağ tıkladığın yerde
belirir; adını F2 ile değiştirirsin.

Her grup ayrı ayrı düzenlenebilir (sağ tık → "Klasörü düzenle…" ya da açık grubun başlığındaki
düğme): ad, renk, kutu opaklığı (%0 = tamamen saydam), bulanıklık, köşe, 2×2 / 3×3 önizleme,
özel resim, açılış stili (iOS / Android) ve panel opaklığı. Ayarlanmayanlar genel ayarları izler.

Ayarlar penceresinde tema, duvar kağıdı, ızgara, klasör stili, saydamlık, animasyon, kısayollar
ve yedekleme var. Sistem tepsisi menüsünde ayarlar, uygulama ekle ve düzeni kilitle bulunur.

Düzen `%APPDATA%\Folder Explorer\state.json` dosyasına anında kaydedilir; son 10 sürüm
`backups\` klasöründe tutulur.

## Geliştirme

Gerekenler: Node.js, Rust (MSVC), WebView2 (Windows 11'de hazır gelir). İlk kez: `npm install`.

**Canlı çalıştırma (kurulum gerekmez):** proje klasöründeki `calistir.bat` dosyasına çift tıkla.
Çalışan Folder Explorer varsa düzgünce kapatır, sonra uygulamayı kaynak koddan başlatır. Arayüz
kodunu (`src/`) değiştirince uygulama anında yenilenir; Rust kodunu (`src-tauri/`) değiştirince
kendiliğinden yeniden derlenip açılır (yaklaşık 20 sn). Kapatmak için pencerede Ctrl+C.

Diğer komutlar:

```bash
npm test
```

```bash
npm run tauri build
```

Son komut kurulum dosyasını üretir (`src-tauri/target/release/bundle/nsis/`); canlı çalıştırma için gerekmez.

* `src/` — React + Motion arayüzü, yerleşim mantığı (`src/layout/model.ts`, birim testli).
* `src-tauri/` — Rust: masaüstü katmanı, Windows simgeleri, kabuk menüleri, dosya işlemleri, kayıt.
* Ayrıntılar: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Tarayıcıda sahte verilerle önizleme: `npm run dev` ve `http://localhost:1420` (Windows
entegrasyonu olmadan, yalnızca arayüz).
