# Değişiklik günlüğü

Kullanıcının fark edeceği değişiklikler. Kurulu sürümün numarası ve derlendiği commit Ayarlar ▸ Hakkında'da görünür.

## 0.2.0 — 2026-10-25

İzlenen ilk sürüm. Daha önceki bütün derlemeler içerikleri farklı olsa da "0.1.0" diyordu; bu yüzden o derlemeler birbirinden ayırt edilemez.

### Yeni

- Akıllı grup, canlı klasör, en çok kullanılanlar ve geçici masa; panel, yığın, sekmeli ve masaüstünde hep açık kutu görünümleri.
- Windows Hello veya PIN ile kilitlenen gruplar; masaüstünde başlık ve ayraçlar.
- Simge plakaları ve simge paketleri, sayfa başına ya da gündüz/gece duvar kâğıdı, duvar kâğıdından vurgu rengi, içe/dışa aktarılabilen hazır temalar. Hazır tema seçince önceki özel görünümüne geri dönebilirsin.
- Aramada hesap makinesi, son dosyalar, Windows ayar sayfaları, dizinlenmiş dosyalar ve web araması; komut paleti (Ctrl+Shift+P) ve Hızlı Bakış (Boşluk).
- Sağ tık Explorer'ın kendi menülerini açar. Windows'un Yeni ▸ menüsüne "Yeni grup oluştur" eklenebilir.
- Tepsi menüsünde Yeni ▸ (grup türleri, kutu, başlık, ayraç) ve Simgeleri düzenle; gruplarda ve kutularda sağ tık menüsü.
- Kurulumda "Bilgisayar açılınca başlat" seçeneği.
- Oyun modu ve pil modu.

### Değişenler

- Ctrl+Space kısayolu kaldırıldı, başka uygulamaların tuşlarını alıyordu. Masaüstünde yazmaya başlamak aramayı açar.
- Düzenleme modundaki ×, gerçek bir dosyayı Geri Dönüşüm Kutusu'na taşımadan önce sorar. Basılı tutunca düzenleme modu Ayarlar ▸ Davranış'tan kapatılabilir.
- Özelleştirme pencereleri kaydedilmemiş değişiklikleri atmadan önce sorar.
- Izgara ekranın sağ kenarına kadar uzanır; bazı simgelerin (çoğu Steam oyunu) çevresindeki soluk çerçeve kalktı.
- Açık grup panelindeki yazılar açık temaya uyar.

### Düzeltmeler

- Explorer ya da WebView2 çökünce uygulama kendini toparlar ve Windows simgelerini geri getirir; Windows'ta simgeler gizliyse gizli kalır.
- Düzen dosyası bozulmaya ve boş kayıtlara karşı korunur: bozuk dosya kenara alınır, en yeni sağlam yedek yüklenir, kayıt başarısız olursa haber verilir.
- Geri al/yinele, yeniden adlandırmaları ve klasöre taşımaları doğru dosyaya uygular (Windows'un "Atla" ve "İkisini de tut" seçenekleri dahil); yavaş bir işlem sürerken yapılan değişiklikler kaybolmaz.
- Yavaş bir silme sürerken taşınan simge geri zıplamaz; son öğesi çıkan grup kaldırılır.
- Yeni ▸ ile oluşturulan öğenin adı hemen sorulur.
- Masaüstündeki seçimi okuyan başka araçlar artık doğru seçimi görür.
- "Terminalde aç", adında özel karakter olan klasörlerde de güvenle çalışır.
- Yeni ▸ menüsünden ya da açılışta konsol penceresi yanıp sönmez.
- Ağdaki yavaş kısayollar duvar kâğıdını ve önizlemeleri bekletmez; değişmeyen masaüstü yenilemeleri yeniden çizilmez ve kaydedilmez; gizli pencereler daha az bellek kullanır.
